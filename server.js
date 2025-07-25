require('dotenv').config();
const express = require('express');
const { Server } = require('socket.io');
const http = require('http');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { 
    origin: process.env.FRONTEND_URL || 'http://localhost:3000', 
    methods: ["GET", "POST"] 
  }
});

const activeRooms = new Map(); 

const TEST_MODE_BOTS_ENABLED = true; 

app.get('/', (req, res) => {
  res.send('Server is running'); 
});

io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id} from ${socket.handshake.address}`); 

  socket.on('join_room', (roomId) => {
    if (!activeRooms.has(roomId)) {
      activeRooms.set(roomId, {
        players: new Map(),
        roundNumbers: new Map(),
        gameStarted: false,
        currentRound: 0,
        readyCountdownTimer: null,
        readyCountdownValue: 0,
      });
    }
    
    const roomState = activeRooms.get(roomId);
    const playersInRoom = roomState.players;
    
    if (playersInRoom.has(socket.id)) {
      console.log(`Player ${socket.id} already in room ${roomId}. Rejoining.`);
      io.to(roomId).emit('room_update', { 
        players: Array.from(playersInRoom.values()) 
      });
      return; 
    }

    if (playersInRoom.size < 5) { 
        const playerNumber = playersInRoom.size + 1; 
        
        const playerData = {
            id: socket.id,
            playerNumber: playerNumber,
            isBot: false, 
            score: 0, 
            isReady: false, 
        };

        playersInRoom.set(socket.id, playerData); 
        socket.join(roomId); 
        
        console.log(`Player ${socket.id} (No. ${playerNumber}) joined room ${roomId}`);
        
        if (TEST_MODE_BOTS_ENABLED && playersInRoom.size === 1) { 
            console.log(`TEST MODE: Adding 4 bot players to room ${roomId}`);
            for (let i = 0; i < 4; i++) {
                const botId = `bot-${roomId}-${Date.now()}-${i}`; 
                const botNumber = playersInRoom.size + 1; 
                playersInRoom.set(botId, { 
                    id: botId, 
                    playerNumber: botNumber, 
                    isBot: true, 
                    score: 0, 
                    isReady: true, 
                });
            }
        }

        io.to(roomId).emit('room_update', { 
            players: Array.from(playersInRoom.values()) 
        });

        checkAllPlayersReady(roomId); 
    } else {
        socket.emit('room_full', 'This room is full. Please try another room.');
        console.log(`Player ${socket.id} tried to join full room ${roomId}`);
    }
  });

  socket.on('player_ready', ({ roomId }) => {
    const roomState = activeRooms.get(roomId);
    if (!roomState) return;

    const player = roomState.players.get(socket.id);
    if (player) {
      player.isReady = true; 
      console.log(`Player ${socket.id} is READY in room ${roomId}`);
      io.to(roomId).emit('room_update', { 
        players: Array.from(roomState.players.values())
      });
      checkAllPlayersReady(roomId); 
    }
  });

  socket.on('submit_number', ({ number, roomId }) => {
    const roomState = activeRooms.get(roomId);
    if (!roomState || !roomState.gameStarted) {
      console.warn(`Attempt to submit number in non-existent or not-started game in room ${roomId}`);
      return;
    }

    roomState.roundNumbers.set(socket.id, number);
    console.log(`Player ${socket.id} submitted: ${number} in room ${roomId}. Total submitted: ${roomState.roundNumbers.size}`);

    if (TEST_MODE_BOTS_ENABLED) {
        roomState.players.forEach(player => {
            if (player.isBot && !roomState.roundNumbers.has(player.id)) {
                const botNumber = Math.floor(Math.random() * 101); 
                roomState.roundNumbers.set(player.id, botNumber);
                console.log(`Bot ${player.id} submitted: ${botNumber} in room ${roomId}`);
            }
        });
    }

    if (roomState.roundNumbers.size === roomState.players.size) {
      console.log(`All players submitted numbers in room ${roomId}. Calculating results...`);
      calculateRoundResults(roomId);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Connection disconnected: ${socket.id}`);
    activeRooms.forEach((roomState, roomId) => { 
      const playersMap = roomState.players;
      if (playersMap.delete(socket.id)) { 
        console.log(`Player ${socket.id} left room ${roomId}`);
        
        if (TEST_MODE_BOTS_ENABLED) {
            const realPlayersLeft = Array.from(playersMap.values()).filter(p => !p.isBot);
            if (realPlayersLeft.length === 0) { 
                console.log(`TEST MODE: Last real player left room ${roomId}. Clearing all bots.`);
                activeRooms.delete(roomId); 
                return; 
            }
        }

        io.to(roomId).emit('room_update', {
          players: Array.from(playersMap.values()) 
        });

        if (playersMap.size === 0) {
            activeRooms.delete(roomId);
            console.log(`Room ${roomId} is now empty and removed.`);
        }
      }
    });
  });
});

function checkAllPlayersReady(roomId) {
    const roomState = activeRooms.get(roomId);
    
    console.log(`--- checkAllPlayersReady called for room ${roomId} ---`);
    console.log(`  Current gameStarted: ${roomState?.gameStarted}`);
    console.log(`  Current players count: ${roomState?.players.size}`);
    
    if (!roomState || roomState.gameStarted || roomState.players.size < 5) {
        console.log(`  Check failed: roomState: ${!!roomState}, gameStarted: ${roomState?.gameStarted}, players.size: ${roomState?.players.size}`);
        return; 
    }

    const allReady = Array.from(roomState.players.values()).every(player => {
        console.log(`  Player ${player.id} (No. ${player.playerNumber}) isReady: ${player.isReady}, isBot: ${player.isBot}`);
        return player.isReady;
    });
    console.log(`  Overall allReady status for room ${roomId}: ${allReady}`);

    if (allReady && !roomState.readyCountdownTimer) { 
        console.log(`All players in room ${roomId} are READY! Starting 5-second countdown...`);
        roomState.readyCountdownValue = 5; 
        io.to(roomId).emit('ready_countdown', { value: roomState.readyCountdownValue });

        roomState.readyCountdownTimer = setInterval(() => {
            roomState.readyCountdownValue--;
            io.to(roomId).emit('ready_countdown', { value: roomState.readyCountdownValue });

            if (roomState.readyCountdownValue <= 0) {
                clearInterval(roomState.readyCountdownTimer);
                roomState.readyCountdownTimer = null;
                roomState.gameStarted = true; 
                roomState.currentRound = 1; 
                console.log(`Game starting in room ${roomId}!`);
                io.to(roomId).emit('game_start', { currentRound: roomState.currentRound }); 
                startRound(roomId); 
            }
        }, 1000); 
    } else if (!allReady && roomState.readyCountdownTimer) { 
        console.log(`Not all ready, stopping countdown for ${roomId}`);
        clearInterval(roomState.readyCountdownTimer);
        roomState.readyCountdownTimer = null;
        roomState.readyCountdownValue = 0;
        io.to(roomId).emit('ready_countdown', { value: 0, stopped: true }); 
    } else {
        console.log(`Condition not met for starting/stopping countdown for ${roomId}. AllReady: ${allReady}, Timer: ${!!roomState.readyCountdownTimer}`);
    }
}

function startRound(roomId) {
    const roomState = activeRooms.get(roomId);
    if (!roomState) return;

    roomState.roundNumbers.clear();
    io.to(roomId).emit('round_start', { currentRound: roomState.currentRound });
    console.log(`Room ${roomId}: Round ${roomState.currentRound} started.`);
}

function calculateRoundResults(roomId) {
    const roomState = activeRooms.get(roomId);
    if (!roomState) return;

    const submittedNumbers = Array.from(roomState.roundNumbers.values());
    // Get submitted numbers with player IDs for display
    const submittedNumbersWithPlayers = Array.from(roomState.roundNumbers.entries()).map(([playerId, number]) => {
        const player = roomState.players.get(playerId);
        return {
            id: playerId,
            playerNumber: player ? player.playerNumber : 'N/A',
            isBot: player ? player.isBot : false,
            submittedNumber: number,
            score: player ? player.score : 0 // Current score before update
        };
    });

    if (submittedNumbers.length === 0) {
        console.warn(`No numbers submitted in room ${roomId} for round ${roomState.currentRound}`);
        endRound(roomId, null, 0, 0, null, submittedNumbersWithPlayers); 
        return;
    }

    const sum = submittedNumbers.reduce((acc, num) => acc + num, 0);
    const average = sum / submittedNumbers.length;
    const target = average * 0.8;

    let winnerId = null;
    let minDifference = Infinity;
    let winningNumber = -1;

    roomState.roundNumbers.forEach((num, playerId) => {
        const difference = Math.abs(num - target);
        if (difference < minDifference) {
            minDifference = difference;
            winnerId = playerId;
            winningNumber = num;
        }
    });

    const losers = [];
    roomState.players.forEach(player => {
        if (player.id !== winnerId) {
            player.score -= 1; 
            losers.push(player.id);
        }
    });

    console.log(`Room ${roomId}: Round ${roomState.currentRound} results:`);
    console.log(`  Submitted Numbers: ${JSON.stringify(Array.from(roomState.roundNumbers.entries()))}`);
    console.log(`  Average: ${average.toFixed(2)}, Target: ${target.toFixed(2)}`);
    console.log(`  Winner: ${winnerId} (Number: ${winningNumber}), Losers: ${losers}`);
    console.log(`  Updated Scores: ${JSON.stringify(Array.from(roomState.players.values()).map(p => ({ id: p.id, score: p.score })))}`);

    endRound(roomId, winnerId, average, target, winningNumber, submittedNumbersWithPlayers);
}

function endRound(roomId, winnerId, average, target, winningNumber, submittedNumbersWithPlayers) { // submittedNumbersWithPlayers receive kiya
    const roomState = activeRooms.get(roomId);
    if (!roomState) return;

    io.to(roomId).emit('round_results', {
        winnerId: winnerId,
        average: average,
        target: target,
        winningNumber: winningNumber,
        updatedPlayers: Array.from(roomState.players.values()), 
        currentRound: roomState.currentRound,
        submittedNumbers: submittedNumbersWithPlayers, // Naya: Submitted numbers bhi bhejo
    });

    checkGameEndConditions(roomId);

    // Prepare for next round
    roomState.currentRound++;
    roomState.roundNumbers.clear(); 

    // 👇 FIX: Next round start delay 10 seconds
    setTimeout(() => {
        if (roomState.players.size > 1) { 
            startRound(roomId);
        } else {
            console.log(`Game in room ${roomId} ended.`);
            io.to(roomId).emit('game_over', { winner: Array.from(roomState.players.values())[0] });
            activeRooms.delete(roomId); 
        }
    }, 10000); // 10 seconds pause
}

function checkGameEndConditions(roomId) {
    const roomState = activeRooms.get(roomId);
    if (!roomState) return;

    let playersEliminatedThisRound = [];
    roomState.players.forEach(player => {
        if (player.score <= -10) {
            playersEliminatedThisRound.push(player.id);
            console.log(`Player ${player.id} eliminated in room ${roomId}!`);
            roomState.players.delete(player.id); 
            io.to(roomId).emit('player_eliminated', { playerId: player.id });
        }
    });

    if (roomState.players.size === 1) {
        console.log(`Game CLEAR for room ${roomId}!`);
        io.to(roomId).emit('game_clear', { winner: Array.from(roomState.players.values())[0] });
        activeRooms.delete(roomId);
        return;
    }
}

const PORT = process.env.PORT || 5000; 
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`); 
});
