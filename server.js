const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.redirect('/admin.html');
});

// 房间数据存储在内存
// rooms: { roomId: { total, groupASize, lots: [], drawn: [], players: {} } }
const rooms = new Map();

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ===== 管理员连接 =====
io.of('/admin').on('connection', (socket) => {
  console.log('Admin connected:', socket.id);

  // 创建房间
  socket.on('create-room', ({ total, groupASize }) => {
    const roomId = generateRoomId();
    const lots = [];
    for (let i = 1; i <= groupASize; i++) lots.push({ group: 'A', num: i });
    for (let i = 1; i <= total - groupASize; i++) lots.push({ group: 'B', num: i });

    rooms.set(roomId, {
      total,
      groupASize,
      lots: shuffle(lots),
      drawn: [],
      players: {},   // socketId -> { name, result }
    });

    socket.join(roomId);
    socket.emit('room-created', { roomId, total, groupASize });
    console.log(`Room created: ${roomId}, total=${total}, A=${groupASize}`);
  });

  // 获取房间状态
  socket.on('get-room-status', (roomId) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('room-error', { msg: '房间不存在' });
    socket.emit('room-status', {
      roomId,
      total: room.total,
      groupASize: room.groupASize,
      remain: room.lots.length,
      drawnCount: room.drawn.length,
      players: Object.values(room.players).map(p => ({ name: p.name, result: p.result })),
    });
  });

  // 重置房间
  socket.on('reset-room', (roomId) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const lots = [];
    for (let i = 1; i <= room.groupASize; i++) lots.push({ group: 'A', num: i });
    for (let i = 1; i <= room.total - room.groupASize; i++) lots.push({ group: 'B', num: i });
    room.lots = shuffle(lots);
    room.drawn = [];
    room.players = {};
    io.of('/user').to(roomId).emit('room-reset');
    socket.emit('room-reset-done');
    broadcastRoomStatus(roomId);
  });
});

// ===== 用户连接 =====
const userIo = io.of('/user');

userIo.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // 加入房间
  socket.on('join-room', ({ roomId, name }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('join-error', { msg: '房间不存在或已结束' });

    // 检查名字是否重复
    const nameExists = Object.values(room.players).some(p => p.name === name);
    if (nameExists) return socket.emit('join-error', { msg: '该名字已存在，请换一个' });

    socket.join(roomId);
    room.players[socket.id] = { name, result: null };
    socket.data.roomId = roomId;

    socket.emit('join-success', { roomId, name });
    broadcastRoomStatus(roomId);
    console.log(`User joined: ${name} -> ${roomId}`);
  });

  // 抽签
  socket.on('draw', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.lots.length === 0) return socket.emit('draw-error', { msg: '签已抽完！' });

    const result = room.lots.pop();
    room.players[socket.id].result = result;
    room.drawn.push({ name: room.players[socket.id].name, ...result });

    // 只发给抽签者本人
    socket.emit('draw-result', { result });
    broadcastRoomStatus(roomId);

    // 全部抽完，通知管理员
    if (room.lots.length === 0) {
      io.of('/admin').to(roomId).emit('all-drawn', {
        pairs: buildPairs(room)
      });
    }
  });

  // 断开连接
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (roomId) {
      const room = rooms.get(roomId);
      if (room && room.players[socket.id]) {
        delete room.players[socket.id];
        broadcastRoomStatus(roomId);
      }
    }
  });
});

function buildPairs(room) {
  const maxNum = Math.max(room.groupASize, room.total - room.groupASize);
  const pairs = [];
  for (let i = 1; i <= maxNum; i++) {
    const a = room.drawn.find(d => d.group === 'A' && d.num === i);
    const b = room.drawn.find(d => d.group === 'B' && d.num === i);
    pairs.push({
      num: i,
      a: a ? { name: a.name, num: a.num } : null,
      b: b ? { name: b.name, num: b.num } : null,
    });
  }
  return pairs;
}

function broadcastRoomStatus(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.of('/admin').to(roomId).emit('room-status', {
    roomId,
    total: room.total,
    groupASize: room.groupASize,
    remain: room.lots.length,
    drawnCount: room.drawn.length,
    players: Object.values(room.players).map(p => ({ name: p.name, result: p.result })),
    pairs: buildPairs(room),
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎲 抽签服务器启动成功！`);
  console.log(`   本地访问: http://localhost:${PORT}`);
  console.log(`   管理员后台: http://localhost:${PORT}/admin.html\n`);
});
