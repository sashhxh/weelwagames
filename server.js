const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
    // Статический сервер для frontend
    if (req.url === '/') {
        fs.readFile(path.join(__dirname, 'casino.html'), (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading casino.html');
            } else {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(data);
            }
        });
    }
});

const wss = new WebSocket.Server({ server });

// Базы данных (в памяти для примера, в продакшене используйте MongoDB/PostgreSQL)
let users = new Map(); // id -> {id, name, balance, isAdmin}
let chatHistory = [];
let onlineUsers = new Set();
let crashGame = {
    isRunning: false,
    currentMultiplier: 1.0,
    crashPoint: null,
    roundTimer: 20,
    players: [],
    bets: [],
    history: [],
    startTime: null
};
let promoCodes = new Map(); // code -> {code, amount, usesLeft, createdBy}
let withdrawRequests = []; // {id, userId, userName, amount, details, status, createdAt}
let userStats = new Map(); // userId -> {totalBets, totalWins, totalWagered}

// Генерация случайного краша (более плавный рост, дольше летит)
function generateCrashPoint() {
    // Вероятность краша на разных множителях
    const probabilities = [
        { multiplier: 1.1, chance: 0.05 },
        { multiplier: 1.5, chance: 0.1 },
        { multiplier: 2.0, chance: 0.15 },
        { multiplier: 3.0, chance: 0.2 },
        { multiplier: 5.0, chance: 0.25 },
        { multiplier: 10.0, chance: 0.15 },
        { multiplier: 20.0, chance: 0.08 },
        { multiplier: 50.0, chance: 0.02 }
    ];
    
    const rand = Math.random();
    let cumulative = 0;
    
    for (const prob of probabilities) {
        cumulative += prob.chance;
        if (rand <= cumulative) {
            // Добавляем немного случайности к множителю
            return prob.multiplier * (0.9 + Math.random() * 0.2);
        }
    }
    
    return 2.0; // По умолчанию
}

// Запуск игры краш
function startCrashGame() {
    if (crashGame.isRunning) return;
    
    crashGame.isRunning = true;
    crashGame.currentMultiplier = 1.0;
    crashGame.crashPoint = generateCrashPoint();
    crashGame.startTime = Date.now();
    crashGame.players = Array.from(onlineUsers);
    crashGame.bets = [];
    
    console.log(`Новая игра началась. Краш будет на: x${crashGame.crashPoint.toFixed(2)}`);
    
    // Рассылаем обновление состояния
    broadcast({
        type: 'game_state',
        state: crashGame
    });
    
    // Запускаем таймер игры
    const gameInterval = setInterval(() => {
        if (!crashGame.isRunning) {
            clearInterval(gameInterval);
            return;
        }
        
        // Медленное увеличение множителя
        const timePassed = (Date.now() - crashGame.startTime) / 1000;
        crashGame.currentMultiplier = 1.0 + (timePassed * 0.1); // Медленнее растет
        
        // Проверка на краш
        if (crashGame.currentMultiplier >= crashGame.crashPoint) {
            endCrashGame();
            clearInterval(gameInterval);
        }
        
        // Рассылаем обновление
        broadcast({
            type: 'game_state',
            state: crashGame
        });
    }, 100); // Обновление каждые 100мс
}

// Завершение игры
function endCrashGame() {
    crashGame.isRunning = false;
    
    // Определяем победителей
    const winners = [];
    crashGame.bets.forEach(bet => {
        if (bet.cashoutMultiplier && bet.cashoutMultiplier <= crashGame.currentMultiplier) {
            const winAmount = bet.amount * bet.cashoutMultiplier;
            winners.push({
                userId: bet.userId,
                userName: bet.userName,
                winAmount: winAmount
            });
            
            // Обновляем баланс пользователя
            const user = users.get(bet.userId);
            if (user) {
                user.balance += winAmount;
            }
            
            // Обновляем статистику
            updateUserStats(bet.userId, true, winAmount, bet.amount);
        } else {
            updateUserStats(bet.userId, false, 0, bet.amount);
        }
    });
    
    // Добавляем в историю
    crashGame.history.unshift({
        multiplier: crashGame.currentMultiplier,
        crashPoint: crashGame.crashPoint,
        winners: winners.length,
        timestamp: Date.now()
    });
    
    if (crashGame.history.length > 10) {
        crashGame.history = crashGame.history.slice(0, 10);
    }
    
    // Рассылаем результаты
    broadcast({
        type: 'game_result',
        result: {
            multiplier: crashGame.currentMultiplier,
            winners: winners,
            timestamp: Date.now()
        }
    });
    
    // Очищаем ставки
    crashGame.bets = [];
    
    // Запускаем таймер до следующей игры
    crashGame.roundTimer = 20;
    const timerInterval = setInterval(() => {
        crashGame.roundTimer--;
        
        broadcast({
            type: 'game_state',
            state: crashGame
        });
        
        if (crashGame.roundTimer <= 0) {
            clearInterval(timerInterval);
            startCrashGame();
        }
    }, 1000);
}

// Обновление статистики пользователя
function updateUserStats(userId, won, winAmount, betAmount) {
    if (!userStats.has(userId)) {
        userStats.set(userId, {
            totalBets: 0,
            totalWins: 0,
            totalWagered: 0,
            totalWon: 0
        });
    }
    
    const stats = userStats.get(userId);
    stats.totalBets++;
    stats.totalWagered += betAmount;
    
    if (won) {
        stats.totalWins++;
        stats.totalWon += winAmount;
    }
}

// Рассылка сообщения всем клиентам
function broadcast(data) {
    const message = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Обработка подключений
wss.on('connection', (ws) => {
    console.log('Новое подключение');
    
    // Обработка сообщений
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleClientMessage(ws, data);
        } catch (error) {
            console.error('Ошибка обработки сообщения:', error);
        }
    });
    
    // Обработка отключения
    ws.on('close', () => {
        console.log('Клиент отключился');
    });
});

// Обработка сообщений от клиентов
function handleClientMessage(ws, data) {
    switch(data.type) {
        case 'auth':
            handleAuth(ws, data.user);
            break;
            
        case 'update_profile':
            handleUpdateProfile(data.user);
            break;
            
        case 'chat_message':
            handleChatMessage(data);
            break;
            
        case 'place_bet':
            handlePlaceBet(data);
            break;
            
        case 'cashout':
            handleCashout(data);
            break;
            
        case 'auto_cashout':
            handleAutoCashout(data);
            break;
            
        case 'use_promo':
            handleUsePromo(data);
            break;
            
        case 'create_promo':
            handleCreatePromo(data);
            break;
            
        case 'withdraw_request':
            handleWithdrawRequest(data);
            break;
    }
}

// Обработка авторизации
function handleAuth(ws, userData) {
    let user = users.get(userData.id);
    
    if (!user) {
        // Новый пользователь
        user = {
            id: userData.id,
            name: userData.name,
            balance: 0, // Нет стартового баланса
            isAdmin: userData.id === 'ADMIN_123', // Пример админа
            createdAt: Date.now()
        };
        users.set(userData.id, user);
    }
    
    // Обновляем данные
    user.name = userData.name;
    if (userData.isAdmin) {
        user.isAdmin = true;
    }
    
    // Добавляем в онлайн
    onlineUsers.add(user.id);
    
    // Отправляем ответ
    ws.send(JSON.stringify({
        type: 'auth_response',
        user: user
    }));
    
    // Отправляем историю чата
    chatHistory.slice(-20).forEach(msg => {
        ws.send(JSON.stringify({
            type: 'chat_message',
            message: msg
        }));
    });
    
    // Отправляем список онлайн пользователей
    updateOnlineUsers();
    
    // Отправляем текущее состояние игры
    ws.send(JSON.stringify({
        type: 'game_state',
        state: crashGame
    }));
}

// Обновление профиля
function handleUpdateProfile(userData) {
    const user = users.get(userData.id);
    if (user) {
        user.name = userData.name;
        user.isAdmin = userData.isAdmin || user.isAdmin;
        
        // Рассылаем обновление
        broadcast({
            type: 'user_update',
            user: user
        });
    }
}

// Сообщение в чат
function handleChatMessage(data) {
    const message = {
        userId: data.userId,
        userName: data.userName,
        message: data.message,
        timestamp: data.timestamp
    };
    
    chatHistory.push(message);
    
    // Ограничиваем историю
    if (chatHistory.length > 1000) {
        chatHistory = chatHistory.slice(-500);
    }
    
    // Рассылаем всем
    broadcast({
        type: 'chat_message',
        message: message
    });
}

// Размещение ставки
function handlePlaceBet(data) {
    const user = users.get(data.userId);
    if (!user || user.balance < data.amount) {
        return;
    }
    
    // Списываем средства
    user.balance -= data.amount;
    
    // Добавляем ставку
    crashGame.bets.push({
        userId: data.userId,
        userName: data.userName,
        amount: data.amount,
        placedAt: Date.now(),
        cashoutMultiplier: null
    });
    
    // Рассылаем обновление пользователю
    broadcastToUser(data.userId, {
        type: 'user_update',
        user: user
    });
    
    // Обновляем состояние игры
    broadcast({
        type: 'game_state',
        state: crashGame
    });
}

// Кэшаут
function handleCashout(data) {
    const betIndex = crashGame.bets.findIndex(b => b.userId === data.userId && !b.cashoutMultiplier);
    
    if (betIndex !== -1) {
        crashGame.bets[betIndex].cashoutMultiplier = data.multiplier;
        
        // Уведомляем пользователя
        broadcastToUser(data.userId, {
            type: 'notification',
            message: `Кэшаут на x${data.multiplier.toFixed(2)}`
        });
    }
}

// Автокэшаут
function handleAutoCashout(data) {
    const betIndex = crashGame.bets.findIndex(b => b.userId === data.userId);
    
    if (betIndex !== -1) {
        const bet = crashGame.bets[betIndex];
        const user = users.get(data.userId);
        
        if (user) {
            user.balance += parseFloat(data.amount);
            
            // Рассылаем обновление
            broadcastToUser(data.userId, {
                type: 'user_update',
                user: user
            });
        }
    }
}

// Использование промокода
function handleUsePromo(data) {
    const promo = promoCodes.get(data.promoCode);
    const user = users.get(data.userId);
    
    if (!promo || promo.usesLeft <= 0 || !user) {
        broadcastToUser(data.userId, {
            type: 'promo_result',
            success: false,
            message: 'Промокод недействителен'
        });
        return;
    }
    
    // Начисляем бонус
    user.balance += promo.amount;
    promo.usesLeft--;
    
    if (promo.usesLeft <= 0) {
        promoCodes.delete(data.promoCode);
    }
    
    broadcastToUser(data.userId, {
        type: 'promo_result',
        success: true,
        amount: promo.amount,
        message: `Промокод активирован! +${promo.amount} ₽`
    });
    
    // Логируем использование
    console.log(`Пользователь ${user.name} использовал промокод ${data.promoCode}`);
}

// Создание промокода
function handleCreatePromo(data) {
    const promoCode = data.code.toUpperCase();
    
    if (promoCodes.has(promoCode)) {
        return;
    }
    
    promoCodes.set(promoCode, {
        code: promoCode,
        amount: data.amount,
        usesLeft: data.uses,
        createdAt: Date.now(),
        createdBy: 'admin'
    });
    
    console.log(`Создан промокод: ${promoCode}, сумма: ${data.amount} ₽, использований: ${data.uses}`);
}

// Заявка на вывод
function handleWithdrawRequest(data) {
    const user = users.get(data.userId);
    if (!user) return;
    
    const request = {
        id: 'W' + Date.now(),
        userId: data.userId,
        userName: data.userName,
        amount: data.amount,
        details: data.details,
        status: 'pending',
        createdAt: Date.now()
    };
    
    withdrawRequests.push(request);
    
    // Сохраняем в файл (для примера)
    saveWithdrawRequests();
    
    console.log(`Новая заявка на вывод: ${data.userName} - ${data.amount} ₽`);
}

// Обновление списка онлайн пользователей
function updateOnlineUsers() {
    const userList = Array.from(onlineUsers).map(id => users.get(id));
    
    broadcast({
        type: 'user_list',
        users: userList
    });
}

// Рассылка конкретному пользователю
function broadcastToUser(userId, data) {
    const message = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.userId === userId && client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Сохранение заявок на вывод
function saveWithdrawRequests() {
    try {
        fs.writeFileSync('withdrawals.json', JSON.stringify(withdrawRequests, null, 2));
    } catch (error) {
        console.error('Ошибка сохранения заявок:', error);
    }
}

// Загрузка заявок на вывод
function loadWithdrawRequests() {
    try {
        if (fs.existsSync('withdrawals.json')) {
            const data = fs.readFileSync('withdrawals.json', 'utf8');
            withdrawRequests = JSON.parse(data);
        }
    } catch (error) {
        console.error('Ошибка загрузки заявок:', error);
    }
}

// Запуск сервера
server.listen(3000, () => {
    console.log('Сервер запущен на порту 3000');
    console.log('Откройте http://localhost:3000 в браузере');
    
    // Загружаем данные
    loadWithdrawRequests();
    
    // Запускаем первую игру через 5 секунд
    setTimeout(() => {
        startCrashGame();
    }, 5000);
});

// Админские команды через консоль
process.stdin.on('data', (data) => {
    const command = data.toString().trim();
    const parts = command.split(' ');
    
    switch(parts[0]) {
        case 'promo':
            if (parts.length >= 4) {
                promoCodes.set(parts[1].toUpperCase(), {
                    code: parts[1].toUpperCase(),
                    amount: parseInt(parts[2]),
                    usesLeft: parseInt(parts[3]),
                    createdAt: Date.now(),
                    createdBy: 'console'
                });
                console.log(`Промокод ${parts[1]} создан`);
            }
            break;
            
        case 'balance':
            if (parts.length >= 3) {
                const user = users.get(parts[1]);
                if (user) {
                    user.balance = parseInt(parts[2]);
                    console.log(`Баланс пользователя ${user.name} установлен: ${parts[2]} ₽`);
                }
            }
            break;
            
        case 'withdraw':
            if (parts.length >= 4) {
                const requestId = parts[1];
                const status = parts[2];
                const amount = parseInt(parts[3]);
                
                const request = withdrawRequests.find(r => r.id === requestId);
                if (request) {
                    request.status = status;
                    
                    const user = users.get(request.userId);
                    if (user && status === 'rejected') {
                        user.balance += amount;
                    }
                    
                    console.log(`Заявка ${requestId} обработана: ${status}`);
                }
            }
            break;
            
        case 'users':
            console.log('Всего пользователей:', users.size);
            users.forEach((user, id) => {
                console.log(`${id}: ${user.name} - ${user.balance} ₽ ${user.isAdmin ? '(админ)' : ''}`);
            });
            break;
            
        case 'help':
            console.log('Доступные команды:');
            console.log('  promo CODE AMOUNT USES - создать промокод');
            console.log('  balance USER_ID AMOUNT - изменить баланс');
            console.log('  withdraw REQUEST_ID STATUS AMOUNT - обработать вывод');
            console.log('  users - список пользователей');
            break;
    }
});
