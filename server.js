
import express from "express";
import cors from "cors";
import http from "http";
import { randomUUID } from "node:crypto";
import { Server } from "socket.io";

const PORT = process.env.PORT || 3000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://127.0.0.1:5500";

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: CLIENT_ORIGIN }));

app.get("/", (req, res) => {
    res.json({
        name: "UNFILED GROUNDS",
        status: "ONLINE",
        multiplayer: true
    });
});

const io = new Server(server, {
    cors: {
        origin: CLIENT_ORIGIN,
        methods: ["GET", "POST"]
    }
});

const MAX_PLAYERS = 12;
const WORLD_LIMIT = 500;
const POSITION_RATE_MS = 50;
const ATTACK_RATE_MS = 180;
const MAX_HEALTH = 100;

const rooms = new Map();

function getRoom(id) {
    if (!rooms.has(id)) rooms.set(id, new Map());
    return rooms.get(id);
}

function cleanRoom(id) {
    const room = rooms.get(id);
    if (room && room.size === 0) rooms.delete(id);
}

function validVector(p) {
    return p &&
        Number.isFinite(p.x) &&
        Number.isFinite(p.y) &&
        Number.isFinite(p.z) &&
        Math.abs(p.x) <= WORLD_LIMIT &&
        Math.abs(p.y) <= WORLD_LIMIT &&
        Math.abs(p.z) <= WORLD_LIMIT;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function publicPlayer(socketId, player) {
    return {
        socketId,
        x: player.x,
        y: player.y,
        z: player.z,
        rotation: player.rotation,
        health: player.health,
        blocking: player.blocking,
        stunnedUntil: player.stunnedUntil,
        velocity: player.velocity
    };
}

function leaveRoom(socket) {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);

    if (room) {
        room.delete(socket.id);

        socket.to(roomId).emit("player:left", {
            socketId: socket.id
        });
    }

    socket.leave(roomId);
    socket.data.roomId = null;
    cleanRoom(roomId);
}

io.on("connection", socket => {
    const player = {
        id: randomUUID(),
        x: 0,
        y: 0,
        z: 0,
        rotation: 0,
        health: MAX_HEALTH,
        blocking: false,
        awakened: false,
        stunnedUntil: 0,
        velocity: { x: 0, y: 0, z: 0 },
        lastPosition: 0,
        lastAttack: 0,
        attackIds: new Set()
    };

    socket.data.player = player;
    socket.data.roomId = null;

    socket.on("room:join", requestedRoom => {
        if (typeof requestedRoom !== "string") return;

        const roomId = requestedRoom.trim().slice(0, 40);
        if (!/^[a-zA-Z0-9_-]+$/.test(roomId)) return;

        leaveRoom(socket);

        const room = getRoom(roomId);

        if (room.size >= MAX_PLAYERS) {
            socket.emit("room:error", "Room is full.");
            return;
        }

        player.x = Math.random() * 8 - 4;
        player.y = 0;
        player.z = Math.random() * 8 - 4;
        player.health = MAX_HEALTH;
        player.stunnedUntil = 0;

        room.set(socket.id, player);
        socket.data.roomId = roomId;
        socket.join(roomId);

        const existingPlayers = [];

        for (const [id, other] of room.entries()) {
            if (id !== socket.id) {
                existingPlayers.push(publicPlayer(id, other));
            }
        }

        socket.emit("room:joined", {
            roomId,
            socketId: socket.id,
            player: publicPlayer(socket.id, player),
            players: existingPlayers
        });

        socket.to(roomId).emit(
            "player:joined",
            publicPlayer(socket.id, player)
        );
    });

    socket.on("player:move", data => {
        const roomId = socket.data.roomId;
        if (!roomId || !validVector(data?.position)) return;

        const now = Date.now();
        if (now - player.lastPosition < POSITION_RATE_MS) return;
        player.lastPosition = now;

        player.x = data.position.x;
        player.y = data.position.y;
        player.z = data.position.z;

        if (Number.isFinite(data.rotation)) {
            player.rotation = data.rotation;
        }

        const room = rooms.get(roomId);
        if (!room) return;

        socket.to(roomId).emit("player:moved", {
            socketId: socket.id,
            position: {
                x: player.x,
                y: player.y,
                z: player.z
            },
            rotation: player.rotation
        });
    });

    socket.on("player:block", value => {
        player.blocking = value === true;

        const roomId = socket.data.roomId;
        if (!roomId) return;

        socket.to(roomId).emit("player:block", {
            socketId: socket.id,
            blocking: player.blocking
        });
    });

    socket.on("player:awaken", value => {
        player.awakened = value === true;

        const roomId = socket.data.roomId;
        if (!roomId) return;

        socket.to(roomId).emit("player:awaken", {
            socketId: socket.id,
            awakened: player.awakened
        });
    });

    // The server validates target distance, direction,
    // cooldown, health, blocking, and damage.
    socket.on("combat:attack", data => {
        const roomId = socket.data.roomId;
        if (!roomId || !data) return;

        const room = rooms.get(roomId);
        if (!room) return;

        const targetId = data.targetSocketId;
        if (typeof targetId !== "string" || targetId === socket.id) return;

        const target = room.get(targetId);
        if (!target || target.health <= 0 || player.health <= 0) return;

        const now = Date.now();
        if (now - player.lastAttack < ATTACK_RATE_MS) return;

        const attackId = String(data.attackId || "");
        if (!attackId || attackId.length > 80) return;
        if (player.attackIds.has(attackId)) return;

        const damage = clamp(Number(data.damage) || 0, 0, 35);
        const range = clamp(Number(data.range) || 0, 0.5, 25);
        const knockback = clamp(Number(data.knockback) || 0, 0, 35);
        const stun = clamp(Number(data.stun) || 0, 0, 3);

        const dx = target.x - player.x;
        const dz = target.z - player.z;
        const distance = Math.hypot(dx, dz);

        if (distance > range + 1.2) return;

        const directionLength = Math.hypot(
            Number(data.direction?.x) || 0,
            Number(data.direction?.z) || 0
        );

        if (directionLength < 0.01) return;

        const dirX = data.direction.x / directionLength;
        const dirZ = data.direction.z / directionLength;

        const dot = (dx / Math.max(distance, 0.001)) * dirX +
            (dz / Math.max(distance, 0.001)) * dirZ;

        if (dot < 0.15) return;

        player.lastAttack = now;
        player.attackIds.add(attackId);

        if (player.attackIds.size > 100) {
            player.attackIds.clear();
        }

        const actualDamage = target.blocking
            ? Math.max(1, damage * 0.2)
            : damage;

        target.health = Math.max(0, target.health - actualDamage);

        const push = target.blocking ? knockback * 0.15 : knockback;

        target.velocity = {
            x: (dx / Math.max(distance, 0.001)) * push,
            y: target.blocking ? 0 : Math.min(5, push * 0.12),
            z: (dz / Math.max(distance, 0.001)) * push
        };

        if (!target.blocking && stun > 0) {
            target.stunnedUntil = now + stun * 1000;
        }

        io.to(roomId).emit("combat:hit", {
            attackId,
            attackerId: socket.id,
            targetId,
            damage: actualDamage,
            health: target.health,
            blocking: target.blocking,
            velocity: target.velocity,
            stunnedUntil: target.stunnedUntil
        });

        if (target.health <= 0) {
            setTimeout(() => {
                const currentRoom = rooms.get(roomId);
                const currentTarget = currentRoom?.get(targetId);

                if (!currentTarget) return;

                currentTarget.health = MAX_HEALTH;
                currentTarget.x = Math.random() * 8 - 4;
                currentTarget.z = Math.random() * 8 - 4;
                currentTarget.velocity = { x: 0, y: 0, z: 0 };
                currentTarget.stunnedUntil = 0;

                io.to(roomId).emit("player:respawn", {
                    socketId: targetId,
                    position: {
                        x: currentTarget.x,
                        y: 0,
                        z: currentTarget.z
                    },
                    health: MAX_HEALTH
                });
            }, 2500);
        }
    });

    socket.on("room:leave", () => leaveRoom(socket));

    socket.on("disconnect", () => {
        leaveRoom(socket);
    });
});

server.listen(PORT, () => {
    console.log(`UNFILED GROUNDS server listening on ${PORT}`);
});
