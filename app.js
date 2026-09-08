//imports
require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const session = require('express-session');
const { io } = require('socket.io-client');
const { Server } = require('socket.io');
const http = require('http');
const sqlite3 = require('sqlite3').verbose();
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');
const { ok } = require('assert');

//database setup
const db = new sqlite3.Database('./db/database.db', (err) => {
    if (err) {
        console.error('Error opening database:', err);
    } else {
        console.log('Connected to database.');
    }
});

db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    paid INTEGER NOT NULL DEFAULT 0,
    beatBoss INTEGER NOT NULL DEFAULT 0,
    fbID INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL DEFAULT 'player'
    )`, (err) => {
    if (err) {
        console.log('Error creating users table:', err);
    } else {
        console.log('Users table ready');
    }
}
)

db.run(`ALTER TABLE users ADD COLUMN beatBoss INTEGER NOT NULL DEFAULT 0`, (err) => {
    if (err) {
        // Column might already exist, which is fine
        if (err.message.includes('duplicate column name')) {
            console.log('beatBoss column already exists');
        } else {
            console.log('Error adding beatBoss column:', err.message);
        }
    } else {
        console.log('beatBoss column added successfully');
    }
});

db.run(`ALTER TABLE users ADD COLUMN fbID INTEGER NOT NULL DEFAULT 0`, (err) => {
    if (err) {
        // Column might already exist, which is fine
        if (err.message.includes('duplicate column name')) {
            console.log('fbID column already exists');
        } else {
            console.log('Error adding fbID column:', err.message);
        }
    } else {
        console.log('fbID column added successfully');
    }
});

db.run(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'player'`, (err) => {
    if (err) {
        if (err.message.includes('duplicate column name')) {
            console.log('role column already exists');
        } else {
            console.log('Error adding role column:', err.message);
        }
    } else {
        console.log('role column added successfully');
    }
});

db.run(`ALTER TABLE users ADD COLUMN profile_picture TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
        console.log('Error adding profile_picture column:', err.message);
    }
});

db.run(`CREATE TABLE IF NOT EXISTS game_settings (
    id INTEGER PRIMARY KEY,
    setting_name TEXT UNIQUE,
    setting_value TEXT
    )`, (err) => {
    if (err) {
        console.log('Error creating game_settings table:', err);
    } else {
        db.run(`INSERT OR IGNORE INTO game_settings (setting_name, setting_value) VALUES (?, ?)`,
            ['game_price', '100'], (err) => {
                if (err) {
                    console.error('Error setting default price', err);
                } else {
                    console.log('Game settings table ready');

                }
            });
    }
}
)

db.run(`CREATE TABLE IF NOT EXISTS player_customization (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE,
    username TEXT,
    color_index INTEGER DEFAULT 0,
    body_shape_index INTEGER DEFAULT 2,
    inner_shape_index INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`, (err) => {
    if (err) {
        console.log('Error creating player_customization table:', err);
    } else {
        console.log('Player customization table ready');
    }
});

//constants
const app = express();
const PORT = process.env.PORT || 3000;
// Admin IDs (comma-separated) can be set via ADMIN_IDS env var, e.g. "27,33,44"
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n)) : [27, 33, 44];
const SESSION_SECRET = process.env.SESSION_SECRET || 'your_secret_key';
const AUTH_URL = process.env.AUTH_URL || 'http://localhost:420/oauth';
const THIS_URL = process.env.THIS_URL || `http://localhost:${PORT}`;
const API_KEY = process.env.API_KEY || 'your_api_key';
const gameSessions = new Map(); // sessionId -> gameData

//middleware
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.set('views', path.join(__dirname, 'views'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
    store: new SQLiteStore({ db: 'sessions.db', dir: './db' }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false
}))

function isAuthenticated(req, res, next) {
    if (req.session.user) next()
    else res.redirect('/login')
};

function normalizeRoleList(value) {
    if (Array.isArray(value)) {
        return [...new Set(value.map(v => String(v).trim().toLowerCase()).filter(Boolean))];
    }

    if (typeof value === 'string') {
        return [...new Set(value.split(',').map(v => v.trim().toLowerCase()).filter(Boolean))];
    }

    return [];
}

function mergeRoles(baseRoles = [], extraRoles = []) {
    return [...new Set([...normalizeRoleList(baseRoles), ...normalizeRoleList(extraRoles)])];
}

function getUserRoles(req) {
    const sessionRoles = normalizeRoleList(req.session?.userRoles || req.session?.userRole);
    return sessionRoles.length ? sessionRoles : ['player'];
}

function getUserRole(req) {
    return getUserRoles(req).join(',');
}

function hasRole(req, role) {
    return !!(req.session && req.session.user && getUserRoles(req).includes(String(role).toLowerCase()));
}



// Helper to check admin status without acting as middleware
function isAdminUser(req) {
    return hasRole(req, 'admin') || hasRole(req, 'owner') || !!(req.session && req.session.user && req.session.token && ADMIN_IDS.includes(req.session.token.id));
}

// Keep middleware but leverage helper
function isAdmin(req, res, next) {
    if (isAdminUser(req)) next();
    else res.status(403).send('Admin access required');
}

function requireRole(role) {
    return (req, res, next) => {
        if (hasRole(req, role) || (role === 'admin' && isAdminUser(req))) return next();
        res.status(403).send('Access denied');
    };
}

function canAssignAdminRole(req) {
    return hasRole(req, 'owner') || !!(req.session && req.session.user && req.session.token && req.session.token.id === 44);
}

function loadPersistentRoles(req, callback) {
    const fallbackRoles = getUserRoles(req);

    if (!req.session?.token?.id) {
        return callback(fallbackRoles);
    }

    db.get('SELECT role FROM users WHERE fbID = ?', [req.session.token.id], (err, row) => {
        if (err) {
            console.error('Error loading persistent roles:', err);
            return callback(fallbackRoles);
        }

        const dbRoles = normalizeRoleList(row?.role);
        const merged = row ? dbRoles : fallbackRoles;
        req.session.userRoles = merged;
        req.session.userRole = merged.join(',');
        callback(merged);
    });
}

function canEditRoles(req, callback) {
    loadPersistentRoles(req, (roles) => {
        const tokenId = req.session?.token?.id;
        callback(
            roles.includes('admin') ||
            roles.includes('owner') ||
            ADMIN_IDS.includes(tokenId) ||
            tokenId === 44 ||
            canAssignAdminRole(req)
        );
    });
}

function loadRolesForRequest(req, res, next) {
    if (!req.session?.user) return next();

    loadPersistentRoles(req, () => next());
}

function requireAnyRole(...roles) {
    return (req, res, next) => {
        const userRoles = getUserRoles(req);
        if (roles.some(role => userRoles.includes(String(role).toLowerCase())) || isAdminUser(req)) {
            return next();
        }
        res.status(403).send('Access denied');
    };
}

app.use(loadRolesForRequest);

function getCurrentPrice(callback) {
    db.get(`SELECT setting_value FROM game_settings WHERE setting_name = ?`, ['game_price'], (err, row) => {
        if (err) {
            console.log('Error getting price:', err);
            callback(1)
        } else {
            callback(parseInt(row ? row.setting_value : 1));
        }
    })
}

// Serve static files (CSS, JS, images)
app.use(express.static(path.join(__dirname)));

// Route for the game
app.get('/', isAuthenticated, (req, res) => {
    getCurrentPrice((price) => {
        const isAdmin = isAdminUser(req);
        console.log('Rendering / for user:', req.session.user, 'token:', req.session.token, 'isAdmin:', isAdmin);

        res.render('index', {
            gamePrice: price,
            isAdmin: isAdmin,
            adminDigipogs: isAdmin ? (req.session.adminDigipogs || 0) : 0,
            userRole: getUserRole(req),
            canAssignAdmin: canAssignAdminRole(req)
        });
    });
});


app.get('/login', (req, res) => {
    if (req.query.token) {
        let tokenData = jwt.decode(req.query.token);
        console.log(tokenData);
        req.session.token = tokenData;
        req.session.user = tokenData.displayName;
        req.session.hasPaid = false;
        const seededRoles = tokenData.id === 44
            ? ['owner', 'admin']
            : (ADMIN_IDS.includes(tokenData.id) ? ['admin'] : ['player']);

        // First try to insert new user
        db.run('INSERT OR IGNORE INTO users (username, fbID, role) VALUES (?, ?, ?)', [tokenData.displayName, tokenData.id, seededRoles.join(',')], function (err) {
            if (err) {
                return console.log(err.message);
            }

            db.get('SELECT role FROM users WHERE fbID = ?', [tokenData.id], (roleErr, row) => {
                if (roleErr) {
                    console.log('Error reading role:', roleErr.message);
                    req.session.userRoles = seededRoles;
                    req.session.userRole = seededRoles.join(',');
                    return req.session.save(() => res.redirect('/'));
                }

                const mergedRoles = mergeRoles(row?.role || [], seededRoles);
                const lockedRoles = tokenData.id === 44
                    ? mergeRoles(mergedRoles, ['owner'])
                    : mergedRoles.filter(role => role !== 'owner');

                db.run('UPDATE users SET fbID = ?, role = ? WHERE fbID = ?', [tokenData.id, lockedRoles.join(','), tokenData.id], function (updateErr) {
                    if (updateErr) {
                        console.log('Error updating fbID/role:', updateErr.message);
                    } else {
                        console.log(`✅ User ${tokenData.displayName} (Formbar ID: ${tokenData.id}) saved/updated in database.`);
                    }

                    req.session.userRoles = lockedRoles;
                    req.session.userRole = lockedRoles.join(',');
                    req.session.save(() => res.redirect('/'));
                });
            });
        });

    } else {
        console.log('No token provided');
        res.redirect(`${AUTH_URL}/oauth?redirectURL=${THIS_URL}`);
    };
});


app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

app.get('/loadCustomization', isAuthenticated, (req, res) => {
    const userId = req.session.token.id;

    db.get('SELECT * FROM player_customization WHERE user_id = ?', [userId], (err, row) => {
        if (err) {
            console.error('Error loading customization:', err);
            res.json({ ok: false, error: 'Failed to load customization' });
        } else if (row) {
            res.json({
                ok: true,
                customization: {
                    colorIndex: row.color_index,
                    bodyShapeIndex: row.body_shape_index,
                    innerShapeIndex: row.inner_shape_index
                }
            });
        } else {
            // No customization found, return defaults
            res.json({
                ok: true,
                customization: {
                    colorIndex: 0,
                    bodyShapeIndex: 2,
                    innerShapeIndex: 0
                }
            });
        }
    });
});

app.get('/debug/myuser', isAuthenticated, (req, res) => {
    const userId = req.session.token.id;
    const username = req.session.user;

    console.log(`Debug: Looking for user with ID: ${userId}, username: ${username}`);

    // Check by ID
    db.get('SELECT * FROM users WHERE fbID = ?', [userId], (err, rowById) => {
        if (err) {
            return res.json({ error: err.message });
        }

        // Also check by username
        db.get('SELECT * FROM users WHERE username = ?', [username], (err2, rowByUsername) => {
            if (err2) {
                return res.json({ error: err2.message });
            }

            res.json({
                searchedUserId: userId,
                searchedUsername: username,
                foundById: rowById || null,
                foundByUsername: rowByUsername || null,
                sessionData: {
                    id: req.session.token.id,
                    displayName: req.session.token.displayName,
                    sessionUser: req.session.user
                }
            });
        });
    });
});

app.get('/debug/dbtest', isAuthenticated, (req, res) => {
    const userId = req.session.token.id;

    // Test 1: Can we read from the database?
    db.get('SELECT * FROM users WHERE id = ?', [userId], (err, row) => {
        if (err) {
            return res.json({ test1: 'FAILED', error: err.message });
        }

        // Test 2: Can we write to the database?
        db.run('UPDATE users SET paid = paid WHERE id = ?', [userId], function (updateErr) {
            if (updateErr) {
                return res.json({
                    test1: 'PASSED',
                    user: row,
                    test2: 'FAILED',
                    updateError: updateErr.message
                });
            }

            res.json({
                test1: 'PASSED',
                user: row,
                test2: 'PASSED',
                rowsAffected: this.changes
            });
        });
    });
});

app.get('/checkGrohlUnlock', isAuthenticated, (req, res) => {
    const userId = req.session.token.id;

    db.get('SELECT beatBoss FROM users WHERE fbID = ?', [userId], (err, row) => {
        if (err) {
            console.log('Error checking Grohl unlock status:', err);
            res.json({ ok: false, error: 'Failed to check unlock status' });
        } else {
            const hasBeatenBoss = row && row.beatBoss === 1;
            res.json({ ok: true, grohlUnlocked: hasBeatenBoss });
        }
    })
})

// Save player customization
app.post('/saveCustomization', isAuthenticated, (req, res) => {
    const userId = req.session.token.id;
    const username = req.session.user;
    const { color_index, body_shape_index, inner_shape_index } = req.body;

    db.run(`INSERT OR REPLACE INTO player_customization 
        (user_id, username, color_index, body_shape_index, inner_shape_index, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [userId, username, color_index, body_shape_index, inner_shape_index],
        function (err) {
            if (err) {
                console.error('Error saving customization:', err);
                return res.json({ ok: false, error: 'Failed to save customization' });
            } else {
                console.log(`Customization saved for user ${username}`);
                res.json({ ok: true, message: 'Customization saved successfully' });
            }
        }
    );
});

// Record Boss defeat
app.post('/recordBossDefeat', isAuthenticated, (req, res) => {
    const { waveNumber } = req.body;
    const userId = req.session.token.id;
    const username = req.session.user;

    if (Number(waveNumber) !== 100 || req.session.gameDifficulty !== 'nightmare') {
        return res.status(403).json({ ok: false, error: 'Grohl requires defeating the wave 100 boss on Nightmare.' });
    }

    console.log(`🎯 Recording boss defeat for user ${username} (ID: ${userId})`);

    // First, check if user exists and current beatBoss status
    db.get('SELECT fbID, username, beatBoss FROM users WHERE fbID = ?', [userId], (err, row) => {
        if (err) {
            console.error('❌ Error checking user:', err);
            return res.json({ ok: false, error: 'Database error' });
        }

        if (!row) {
            console.log(`❌ User ${userId} not found in database`);
            return res.json({ ok: false, error: 'User not found' });
        }

        console.log(`📊 Current user data:`, row);

        // Now update the beatBoss status
        db.run('UPDATE users SET beatBoss = 1 WHERE fbID = ?', [userId], function (err) {
            if (err) {
                console.error('❌ Error updating boss defeat status:', err);
                return res.json({ ok: false, error: 'Failed to record boss defeat' });
            }

            console.log(`✅ UPDATE executed. Rows affected: ${this.changes}`);

            if (this.changes === 0) {
                console.log(`⚠️  No rows were updated! User ID ${userId} might not exist.`);
                return res.json({ ok: false, error: 'No rows updated' });
            }

            // Verify the update worked
            db.get('SELECT beatBoss FROM users WHERE fbID = ?', [userId], (err, updatedRow) => {
                if (err) {
                    console.error('❌ Error verifying update:', err);
                } else {
                    console.log(`✅ Verification: User ${userId} beatBoss is now:`, updatedRow.beatBoss);
                }

                res.json({
                    ok: true,
                    message: 'Boss defeat recorded successfully',
                    grohlUnlocked: true,
                    debug: {
                        rowsAffected: this.changes,
                        newBeatBossValue: updatedRow ? updatedRow.beatBoss : 'unknown'
                    }
                });
            });
        });
    });
});


app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/payIn', isAuthenticated, (req, res) => {
    res.render('pay', { user: req.session.user });
});

// Handle the actual payment transfer
app.post('/payIn', isAuthenticated, (req, res) => {
    const { pin } = req.body;
    const userId = req.session.token.id;

    getCurrentPrice((currentPrice) => {

        const data = {
            from: userId,
            to: 57, // Replace with proper formbar ID or Pog Pool ID
            amount: currentPrice,
            pin: parseInt(pin),
            reason: 'Game Entry Fee',
            pool: 'true' //Comment out when paying to one users. Uncomment when paying to pog pool instead of formbar account
        };

        console.log('Processing payment:', data);

        const transferPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Transfer timeout'));
            }, 10000);

            socket.once('transferResponse', (response) => {
                clearTimeout(timeout);
                resolve(response);
            });

            socket.emit('transferDigipogs', data);
        });

        transferPromise
            .then(response => {
                console.log('Transfer response:', response);
                if (response.success) {
                    req.session.hasPaid = true;

                    console.log('=== Payment Success Debug ===');
                    console.log('Session ID after payment:', req.sessionID);
                    console.log('req.session.hasPaid after setting:', req.session.hasPaid);
                    console.log('==============================');

                    // Save session BEFORE responding
                    req.session.save((err) => {
                        if (err) {
                            console.error('Session save error:', err);
                            return res.json({ ok: false, error: 'Session save failed' });
                        }

                        console.log('Session saved successfully');
                        console.log('Sending success response to client');
                        res.json({ ok: true, message: 'Payment successful' });
                    });
                } else {
                    console.log('Sending failure response to client:', response.message);
                    res.json({ ok: false, error: response.message || 'Transfer failed' });
                }
            })
            .catch(error => {
                console.error('Transfer error:', error);
                res.json({ ok: false, error: 'Transfer failed' });
            });
    });
});

app.post('/checkGameAccess', isAuthenticated, (req, res) => {
    const existingSession = gameSessions.get(req.sessionID);

    // Check if user has active game session or valid payment
    if (isAdminUser(req) || req.session.hasPaid || (existingSession && existingSession.active)) {
        // Admins bypass payment, and paid/active sessions also bypass
        res.json({ needsPayment: false });
    } else {
        getCurrentPrice((price) => {
            res.json({ needsPayment: true, cost: price });
        });
    }
});

// Admin: skip payment and create a free game session (for local testing)
// Does not work
app.post('/adminStartGame', isAuthenticated, isAdmin, (req, res) => {
    // Mark session as paid and create a server-controlled game session for admins
    req.session.hasPaid = true;

    const gameSession = {
        sessionId: req.sessionID,
        userId: req.session.token ? req.session.token.id : null,
        startTime: Date.now(),
        currentWave: 1,
        wavesCompleted: 0,
        active: true,
        lastActivity: Date.now()
    };

    gameSessions.set(req.sessionID, gameSession);

    req.session.save((err) => {
        if (err) return res.json({ ok: false, error: 'Session save failed' });
        res.json({ ok: true, sessionId: req.sessionID });
    });
});

// Start game session
app.post('/startGameSession', isAuthenticated, (req, res) => {
    const requestedDifficulty = String(req.body?.difficulty || '').toLowerCase();
    req.session.gameDifficulty = ['easy', 'normal', 'hard', 'nightmare'].includes(requestedDifficulty)
        ? requestedDifficulty
        : 'normal';

    // Allow admins to start without payment
    if (!req.session.hasPaid && !isAdminUser(req)) {
        return res.json({ ok: false, error: 'Payment required' });
    }

    // Create server-controlled game session
    const gameSession = {
        sessionId: req.sessionID,
        userId: req.session.token.id,
        startTime: Date.now(),
        currentWave: 1,
        wavesCompleted: 0,
        active: true,
        lastActivity: Date.now()
    };

    gameSessions.set(req.sessionID, gameSession);

    // Clear payment flag since game is starting
    req.session.hasPaid = false;

    console.log(`Game session started for user ${req.session.user}`);
    res.json({ ok: true, sessionId: req.sessionID });
});

// Validate and record game events
app.post('/recordGameEvent', isAuthenticated, (req, res) => {
    const { eventType, data } = req.body;
    const gameSession = gameSessions.get(req.sessionID);

    if (!checkRateLimit(req.sessionID)) {
        return res.json({ ok: false, error: 'Rate limit exceeded' });
    }
    if (!gameSession || !gameSession.active) {
        return res.json({ ok: false, error: 'No active game session' });
    }

    gameSession.lastActivity = Date.now();

    switch (eventType) {
        case 'WAVE_COMPLETE':
            return handleWaveComplete(gameSession, data, res);
        default:
            return res.json({ ok: false, error: 'Unknown event type' });
    }
});

app.get('/admin', isAuthenticated, requireRole('admin'), (req, res) => {
    getCurrentPrice((price) => {
        res.render('admin', { currentPrice: price, user: req.session.user })
    });
});

app.post('/admin/setDigipogs', isAuthenticated, requireRole('admin'), (req, res) => {
    const rawAmount = req.body?.amount;
    const amount = Number(rawAmount);
    if (rawAmount === undefined || rawAmount === null || String(rawAmount).trim() === '' || !Number.isSafeInteger(amount) || amount < 0) {
        return res.status(400).json({ ok: false, error: 'Enter a non-negative whole number.' });
    }

    req.session.adminDigipogs = amount;
    req.session.save((err) => {
        if (err) return res.status(500).json({ ok: false, error: 'Failed to save Digipog setting' });
        res.json({ ok: true, amount });
    });
});

function getPlayerbase(req, res) {
    canEditRoles(req, (editable) => {
        const query = `SELECT username, fbID, role, beatBoss, profile_picture
                       FROM users
                       ORDER BY CASE WHEN role LIKE '%owner%' THEN 0 WHEN role LIKE '%admin%' THEN 1 ELSE 2 END, username COLLATE NOCASE ASC`;

        db.all(query, [], (err, rows) => {
            if (err && err.message.includes('no such column: profile_picture')) {
                return db.all(
                    `SELECT username, fbID, role, beatBoss
                     FROM users
                     ORDER BY CASE WHEN role LIKE '%owner%' THEN 0 WHEN role LIKE '%admin%' THEN 1 ELSE 2 END, username COLLATE NOCASE ASC`,
                    [],
                    (fallbackErr, fallbackRows) => sendPlayerbaseResponse(fallbackErr, fallbackRows)
                );
            }
            sendPlayerbaseResponse(err, rows);
        });

        function sendPlayerbaseResponse(err, rows) {
            if (err) {
                console.error('Error loading playerbase:', err);
                return res.status(500).json({ ok: false, error: 'Failed to load playerbase' });
            }

            const players = (rows || []).map(row => ({
                ...row,
                profilePicture: row.profile_picture || null,
                roles: normalizeRoleList(row.role),
                isOwner: normalizeRoleList(row.role).includes('owner')
            }));

            res.json({ ok: true, players, canEditRoles: editable, canAssignAdmin: canAssignAdminRole(req), canViewPlayers: true });
        }
    });
}

app.get('/playerbase/data', isAuthenticated, getPlayerbase);
app.get('/admin/playerbase', isAuthenticated, getPlayerbase);

app.get('/profilePicture', isAuthenticated, (req, res) => {
    db.get('SELECT profile_picture FROM users WHERE fbID = ?', [req.session.token.id], (err, row) => {
        if (err) return res.status(500).json({ ok: false, error: 'Failed to load profile picture' });
        res.json({ ok: true, profilePicture: row?.profile_picture || null });
    });
});

app.post('/profilePicture', isAuthenticated, (req, res) => {
    const profilePicture = typeof req.body.profilePicture === 'string' ? req.body.profilePicture : '';
    const isValidImage = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(profilePicture);
    if (profilePicture && (!isValidImage || profilePicture.length > 1500000)) {
        return res.status(400).json({ ok: false, error: 'Use a PNG, JPG, WEBP, or GIF image under 1 MB.' });
    }

    db.run('UPDATE users SET profile_picture = ? WHERE fbID = ?', [profilePicture || null, req.session.token.id], function (err) {
        if (err) return res.status(500).json({ ok: false, error: 'Failed to save profile picture' });
        res.json({ ok: true, profilePicture: profilePicture || null });
    });
});

app.get('/playerbase', isAuthenticated, (req, res) => {
    canEditRoles(req, (editable) => {
        res.render('admin-playerbase', {
            user: req.session.user,
            canEditRoles: editable,
            canAssignAdmin: canAssignAdminRole(req),
            canViewPlayers: true,
        });
    });
});

app.get('/admin/playerbase-page', isAuthenticated, requireAnyRole('moderator', 'admin', 'owner'), (req, res) => {
    canEditRoles(req, (editable) => {
        res.render('admin-playerbase', {
            user: req.session.user,
            canEditRoles: editable,
            canAssignAdmin: canAssignAdminRole(req),
            canViewPlayers: true
        });
    });
});

app.post('/admin/updateRole', isAuthenticated, requireRole('admin'), (req, res) => {
    const { fbID, roles } = req.body;
    const targetFbID = parseInt(fbID, 10);
    const requestedRoles = normalizeRoleList(roles);

    if (!Number.isInteger(targetFbID)) {
        return res.json({ ok: false, error: 'Invalid player ID' });
    }

    if (requestedRoles.includes('owner')) {
        return res.json({ ok: false, error: 'Owner role cannot be manually assigned or removed' });
    }

    loadPersistentRoles(req, (currentEditorRoles) => {
        const canEdit = currentEditorRoles.includes('admin') || currentEditorRoles.includes('owner') || ADMIN_IDS.includes(req.session?.token?.id);
        const allowedRoles = canAssignAdminRole(req) ? ['player', 'moderator', 'admin'] : ['player', 'moderator'];

        if (!canEdit) {
            return res.json({ ok: false, error: 'Access denied' });
        }

        for (const role of requestedRoles) {
            if (!allowedRoles.includes(role)) {
                return res.json({ ok: false, error: 'You are not allowed to assign one of those roles' });
            }
        }

        db.get('SELECT role FROM users WHERE fbID = ?', [targetFbID], (err, row) => {
        if (err) {
            console.error('Error reading current roles:', err);
            return res.json({ ok: false, error: 'Failed to read current roles' });
        }

        if (!row) {
            return res.json({ ok: false, error: 'No matching player found' });
        }

        const currentRoles = normalizeRoleList(row.role);
        const preservedOwner = targetFbID === 44 || currentRoles.includes('owner');
        const finalRoles = preservedOwner
            ? mergeRoles(requestedRoles, ['owner'])
            : requestedRoles;

        if (targetFbID === 44 && !finalRoles.includes('owner')) {
            finalRoles.push('owner');
        }

        db.run(
            'UPDATE users SET role = ? WHERE fbID = ?',
            [finalRoles.join(','), targetFbID],
            function (updateErr) {
                if (updateErr) {
                    console.error('Error updating role:', updateErr);
                    return res.json({ ok: false, error: 'Failed to update role' });
                }

                res.json({ ok: true, message: 'Roles updated successfully', fbID: targetFbID, roles: finalRoles });
            }
        );
        });
    });
});

app.post('/admin/updatePrice', isAuthenticated, requireRole('admin'), (req, res) => {
    const { newPrice } = req.body;
    db.run(`UPDATE game_settings SET setting_value = ? WHERE setting_name = ?`,
        [newPrice, 'game_price'],
        function (err) {
            if (err) {
                console.log('Error updating price:', err);
                res.json({ ok: false, error: 'Failed to update price' });
            } else {
                console.log(`Price updated to ${newPrice}`);
                gameSocket.emit('priceUpdate', { newPrice: newPrice });
                res.json({ ok: true, message: 'Price updated successfully' });
            }
        }
    );
});

// Handle wave completion with anti-cheat validation
function handleWaveComplete(gameSession, data, res) {
    const { waveNumber, timeTaken } = data;

    // Update server-side game state
    gameSession.currentWave = waveNumber + 1;
    gameSession.wavesCompleted = waveNumber;

    res.json({
        ok: true,
        nextWave: gameSession.currentWave,
    });
}

// Delete inactive games if away for 5 minutes
setInterval(() => {
    const now = Date.now();
    const maxInactiveTime = 5 * 60 * 1000;

    for (const [sessionId, gameSession] of gameSessions.entries()) {
        if (now - gameSession.lastActivity > maxInactiveTime) {
            console.log(`Cleaning up inactive session: ${sessionId}`);
            gameSessions.delete(sessionId);
        }
    }
}, 60000); // Check 

// rate limiting
const rateLimits = new Map(); // sessionId -> { requests: number, resetTime: timestamp }

function checkRateLimit(sessionId) {
    const now = Date.now();
    const limit = rateLimits.get(sessionId) || { requests: 0, resetTime: now + 60000 };

    if (now > limit.resetTime) {
        limit.requests = 0;
        limit.resetTime = now + 60000;
    }

    limit.requests++;
    rateLimits.set(sessionId, limit);

    return limit.requests < 100; // Max 100 requests per minute
}

//socket connection to auth server
const socket = io(AUTH_URL, {
    extraHeaders: {
        api: API_KEY
    }
});

console.log('Socket connection state:', socket.connected);
console.log('Attempting to connect to:', AUTH_URL);


socket.on('connect', () => {
    console.log('Connected to auth server');
    socket.emit('getActiveClass');
    console.log('Requested active class data');

});

socket.on('connect_error', (error) => {
    console.log('Socket connection error:', error);
});

socket.on('disconnect', (reason) => {
    console.log('Socket disconnected:', reason);
});

socket.on('setClass', (classData) => {
    console.log('Received class data:', classData);
    // You can store or process the class data as needed
});

// Check the transfer response
socket.on("transferResponse", (response) => {
    console.log("Received transfer response from server.");
    console.log("Transfer Response:", response);
    // response will be: { success: true/false, message: "..." }
});

socket.onAny((eventName, ...args) => {
    console.log('Received socket event:', eventName, args);
});

//start server
const server = http.createServer(app);
const gameSocket = new Server(server);

gameSocket.on('connection', (socket) => {
    console.log('Client connected to game socket:', socket.id);

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

server.listen(PORT, () => {
    console.log(`Server is running on port http://localhost:${PORT}`);
});