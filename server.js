const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const moment = require('moment');
const crypto = require('crypto');
const ZKLib = require('node-zklib');
const XLSX = require('xlsx');

const app = express();
const port = process.env.PORT || 3000;

// Penyimpanan session in-memory untuk autentikasi akun
const sessions = new Map();

function parseCookies(req) {
    const list = {};
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return list;
    cookieHeader.split(';').forEach(cookie => {
        let [name, ...rest] = cookie.split('=');
        name = name ? name.trim() : '';
        if (!name) return;
        const value = rest.join('=').trim();
        if (!value) return;
        list[name] = decodeURIComponent(value);
    });
    return list;
}

// Setup EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Setup Database SQLite (Persisten)
const dbPath = path.join(__dirname, 'absensi.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');

        db.serialize(() => {
            // Gunakan WAL mode agar operasi baca/tulis tidak saling memblokir (non-blocking)
            db.run(`PRAGMA journal_mode = WAL`);
            db.run(`PRAGMA busy_timeout = 5000`);

            // Table Pengaturan Mesin (key-value)
            db.run(`CREATE TABLE IF NOT EXISTS pengaturan (
                kunci TEXT PRIMARY KEY,
                nilai TEXT NOT NULL
            )`, () => {
                db.run(`INSERT OR IGNORE INTO pengaturan (kunci, nilai) VALUES ('machine_ip', '192.168.0.11')`);
                db.run(`INSERT OR IGNORE INTO pengaturan (kunci, nilai) VALUES ('machine_port', '4370')`);
            });

            // Table Akun (id, nama, username, password, role)
            db.run(`CREATE TABLE IF NOT EXISTS akun (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nama TEXT NOT NULL,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'admin'
            )`, () => {
                // Pastikan kolom role tersedia jika tabel sudah ada sebelumnya
                db.all(`PRAGMA table_info(akun)`, (pragmaErr, columns) => {
                    if (!pragmaErr && Array.isArray(columns)) {
                        const hasRole = columns.some(col => col.name === 'role');
                        if (!hasRole) {
                            db.run(`ALTER TABLE akun ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'`);
                        }
                    }
                    // Buat akun default superadmin dan admin jika tabel masih kosong
                    db.get(`SELECT COUNT(*) as total FROM akun`, (countErr, row) => {
                        if (!countErr && row && row.total === 0) {
                            db.run(
                                `INSERT INTO akun (nama, username, password, role) VALUES (?, ?, ?, ?)`,
                                ['Super Admin', 'superadmin', 'superadmin123', 'superadmin']
                            );
                            db.run(
                                `INSERT INTO akun (nama, username, password, role) VALUES (?, ?, ?, ?)`,
                                ['Admin', 'admin', 'admin123', 'admin']
                            );
                        }
                    });
                });
            });

            // Table Karyawan (uid is the deviceUserId/userId) - Persisten tanpa DROP TABLE
            db.run(`CREATE TABLE IF NOT EXISTS karyawan (
                uid TEXT PRIMARY KEY,
                nama TEXT NOT NULL,
                jabatan TEXT DEFAULT '',
                perusahaan TEXT DEFAULT '',
                divisi TEXT DEFAULT ''
            )`);

            // Pastikan kolom jabatan, perusahaan, dan divisi tersedia untuk database yang sudah ada sebelumnya
            db.all(`PRAGMA table_info(karyawan)`, (pragmaErr, columns) => {
                if (!pragmaErr && Array.isArray(columns)) {
                    const hasJabatan = columns.some(col => col.name === 'jabatan');
                    if (!hasJabatan) {
                        db.run(`ALTER TABLE karyawan ADD COLUMN jabatan TEXT DEFAULT ''`);
                    }
                    const hasPerusahaan = columns.some(col => col.name === 'perusahaan');
                    if (!hasPerusahaan) {
                        db.run(`ALTER TABLE karyawan ADD COLUMN perusahaan TEXT DEFAULT ''`);
                    }
                    const hasDivisi = columns.some(col => col.name === 'divisi');
                    if (!hasDivisi) {
                        db.run(`ALTER TABLE karyawan ADD COLUMN divisi TEXT DEFAULT ''`);
                    }
                }
            });

            // Table Absensi - Persisten tanpa DROP TABLE
            db.run(`CREATE TABLE IF NOT EXISTS absensi (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uid TEXT NOT NULL,
                waktu TEXT NOT NULL,
                status TEXT NOT NULL,
                FOREIGN KEY (uid) REFERENCES karyawan(uid)
            )`);

            // Skema Database Struktur Perusahaan (Perusahaan, Divisi, dan Hierarki Struktur)
            db.run(`CREATE TABLE IF NOT EXISTS perusahaan (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nama TEXT NOT NULL
            )`);

            db.run(`CREATE TABLE IF NOT EXISTS divisi (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nama TEXT NOT NULL
            )`);

            db.run(`CREATE TABLE IF NOT EXISTS struktur_perusahaan (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                node_id TEXT UNIQUE NOT NULL,
                tipe TEXT NOT NULL,
                ref_id INTEGER NOT NULL,
                nama TEXT NOT NULL,
                parent_node_id TEXT DEFAULT NULL,
                urutan INTEGER DEFAULT 0
            )`);

            // Index untuk mempercepat query dashboard, pengecekan sync incremental, dan ekspor data
            db.run(`CREATE INDEX IF NOT EXISTS idx_absensi_waktu ON absensi(waktu DESC)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_absensi_uid_waktu ON absensi(uid, waktu)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_karyawan_nama ON karyawan(nama)`);

            // Perbaiki database: hapus log absen di masa depan (misal jam 18 padahal siang)
            const currentTime = moment().format('YYYY-MM-DD HH:mm:ss');
            db.run(`DELETE FROM absensi WHERE waktu > ?`, [currentTime]);
        });
    }
});

// Helper Promise untuk SQLite agar non-blocking dan mudah dikelola
function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function yieldEventLoop() {
    return new Promise((resolve) => setImmediate(resolve));
}

// Helper konfigurasi mesin (IP & Port)
async function getMachineConfig() {
    try {
        const rows = await dbAll(`SELECT kunci, nilai FROM pengaturan WHERE kunci IN ('machine_ip', 'machine_port')`);
        let ip = '192.168.0.11';
        let port = 4370;
        if (Array.isArray(rows)) {
            rows.forEach(r => {
                if (r.kunci === 'machine_ip' && r.nilai) ip = r.nilai;
                if (r.kunci === 'machine_port' && r.nilai) port = parseInt(r.nilai, 10) || 4370;
            });
        }
        return { ip, port };
    } catch (e) {
        return { ip: '192.168.0.11', port: 4370 };
    }
}

// Middleware Autentikasi Akun
async function requireAuth(req, res, next) {
    try {
        const cookies = parseCookies(req);
        const token = cookies.session_token;
        if (!token || !sessions.has(token)) {
            if (req.path.startsWith('/api/')) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            return res.redirect('/login');
        }
        const sessionData = sessions.get(token);
        const user = await dbGet(`SELECT id, nama, username, password, role FROM akun WHERE id = ?`, [sessionData.userId]);
        if (!user) {
            sessions.delete(token);
            if (req.path.startsWith('/api/')) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            return res.redirect('/login');
        }
        req.user = user;
        res.locals.user = user;
        next();
    } catch (err) {
        console.error('Auth error:', err);
        res.redirect('/login');
    }
}

// Routes Login & Logout
app.get('/login', async (req, res) => {
    const cookies = parseCookies(req);
    const token = cookies.session_token;
    if (token && sessions.has(token)) {
        const sessionData = sessions.get(token);
        const user = await dbGet(`SELECT id FROM akun WHERE id = ?`, [sessionData.userId]);
        if (user) return res.redirect('/');
    }
    res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
    try {
        const username = (req.body.username || '').trim();
        const password = req.body.password || '';

        const user = await dbGet(
            `SELECT id, nama, username, password, role FROM akun WHERE username = ? AND password = ?`,
            [username, password]
        );

        if (!user) {
            return res.render('login', { error: 'Username atau password salah!' });
        }

        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, { userId: user.id, createdAt: Date.now() });
        res.setHeader('Set-Cookie', `session_token=${token}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax`);
        res.redirect('/');
    } catch (err) {
        console.error('Login error:', err);
        res.render('login', { error: 'Terjadi kesalahan saat proses login.' });
    }
});

app.get('/logout', (req, res) => {
    const cookies = parseCookies(req);
    const token = cookies.session_token;
    if (token) {
        sessions.delete(token);
    }
    res.setHeader('Set-Cookie', `session_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
    res.redirect('/login');
});

// Proteksi seluruh route di bawah ini dengan login
app.use(requireAuth);

// Route Update Konfigurasi Mesin (IP Address & Port)
app.post('/machine/update', async (req, res) => {
    try {
        if (req.user.role !== 'superadmin') {
            return res.redirect('/?msg=' + encodeURIComponent('Akses ditolak! Hanya Superadmin yang dapat edit mesin.') + '&type=error');
        }
        const ip = (req.body.ip || '').trim();
        const portVal = parseInt(req.body.port, 10) || 4370;

        if (!ip) {
            return res.redirect('/?msg=' + encodeURIComponent('IP Address mesin tidak boleh kosong!') + '&type=error');
        }

        await dbRun(`INSERT OR REPLACE INTO pengaturan (kunci, nilai) VALUES ('machine_ip', ?)`, [ip]);
        await dbRun(`INSERT OR REPLACE INTO pengaturan (kunci, nilai) VALUES ('machine_port', ?)`, [String(portVal)]);

        // Reset cache pengecekan status mesin agar langsung mengecek IP & Port baru
        lastMachineCheckTime = 0;

        res.redirect('/?msg=' + encodeURIComponent(`Pengaturan mesin berhasil diperbarui (${ip}:${portVal})!`) + '&type=success');
    } catch (err) {
        console.error('Gagal update pengaturan mesin:', err);
        res.redirect('/?msg=' + encodeURIComponent('Gagal memperbarui pengaturan mesin.') + '&type=error');
    }
});

// Route Update Profil (nama dan password bisa diganti, username tidak bisa diganti)
app.post('/profile/update', async (req, res) => {
    try {
        const nama = (req.body.nama || '').trim();
        const password = (req.body.password || '').trim();

        if (!nama) {
            return res.redirect('/?msg=' + encodeURIComponent('Nama tidak boleh kosong!') + '&type=error');
        }

        if (password) {
            await dbRun(`UPDATE akun SET nama = ?, password = ? WHERE id = ?`, [nama, password, req.user.id]);
        } else {
            await dbRun(`UPDATE akun SET nama = ? WHERE id = ?`, [nama, req.user.id]);
        }

        res.redirect('/?msg=' + encodeURIComponent('Profil berhasil diperbarui!') + '&type=success');
    } catch (err) {
        console.error('Gagal update profil:', err);
        res.redirect('/?msg=' + encodeURIComponent('Gagal memperbarui profil.') + '&type=error');
    }
});

// Route Tambah Admin (Hanya untuk superadmin)
app.post('/admin/add', async (req, res) => {
    try {
        if (req.user.role !== 'superadmin') {
            return res.redirect('/?msg=' + encodeURIComponent('Akses ditolak! Hanya Superadmin yang dapat menambah admin.') + '&type=error');
        }

        const nama = (req.body.nama || '').trim();
        const username = (req.body.username || '').trim();
        const password = (req.body.password || '').trim();

        if (!nama || !username || !password) {
            return res.redirect('/?msg=' + encodeURIComponent('Semua kolom wajib diisi!') + '&type=error');
        }

        const existing = await dbGet(`SELECT id FROM akun WHERE username = ?`, [username]);
        if (existing) {
            return res.redirect('/?msg=' + encodeURIComponent('Username sudah digunakan, silakan pilih username lain!') + '&type=error');
        }

        await dbRun(
            `INSERT INTO akun (nama, username, password, role) VALUES (?, ?, ?, 'admin')`,
            [nama, username, password]
        );

        res.redirect('/?msg=' + encodeURIComponent('Akun Admin baru berhasil ditambahkan!') + '&type=success');
    } catch (err) {
        console.error('Gagal menambah admin:', err);
        res.redirect('/?msg=' + encodeURIComponent('Gagal menambahkan admin.') + '&type=error');
    }
});

// API Restart Mesin
app.post('/api/restart-machine', async (req, res) => {
    try {
        if (req.user.role !== 'superadmin') {
            return res.status(403).json({ success: false, message: 'Hanya superadmin yang bisa restart mesin.' });
        }
        
        const config = await getMachineConfig();
        const zkInstance = new ZKLib(config.ip, config.port, 10000, 4000);
        
        await zkInstance.createSocket();
        
        // Command 1004 adalah CMD_RESTART pada ZK protocol
        await zkInstance.executeCmd(1004, '');
        
        try {
            await zkInstance.disconnect();
        } catch (e) {}

        res.json({ success: true, message: 'Mesin sedang di-restart.' });
    } catch (err) {
        console.error('Gagal restart mesin:', err);
        res.status(500).json({ success: false, message: 'Gagal restart mesin: ' + err.message });
    }
});

// State untuk tracking proses sinkronisasi di background (non-blocking)
const syncState = {
    isSyncing: false,
    type: null, // 'karyawan' | 'absensi' | null
    status: 'idle', // 'idle' | 'running' | 'completed' | 'error'
    progress: 0,
    total: 0,
    processed: 0,
    added: 0,
    message: 'Siap melakukan sinkronisasi.',
    updatedAt: Date.now()
};

function updateSyncState(patch) {
    Object.assign(syncState, patch, { updatedAt: Date.now() });
}

// Helper CTE untuk memfilter log absensi harian sesuai aturan:
// 1. Absen pertama pada hari tersebut = JAM MASUK
// 2. Absen < 1 jam (3600 detik) sejak jam masuk = DIABAIKAN
// 3. Absen >= 1 jam sejak jam masuk = JAM PULANG (jika berkali-kali setelah 1 jam, ambil log terakhir sebagai jam pulang)
const FILTERED_ABSENSI_CTE = `
    WITH DailyStats AS (
        SELECT 
            id,
            uid,
            waktu,
            status,
            MIN(waktu) OVER (PARTITION BY uid, date(waktu)) as first_waktu,
            ROW_NUMBER() OVER (PARTITION BY uid, date(waktu) ORDER BY waktu ASC, id ASC) as rn_asc,
            ROW_NUMBER() OVER (PARTITION BY uid, date(waktu) ORDER BY waktu DESC, id DESC) as rn_desc
        FROM absensi
    ),
    ValidAbsensi AS (
        SELECT 
            id,
            uid,
            waktu,
            CASE 
                WHEN rn_asc = 1 THEN 'Masuk'
                ELSE 'Pulang'
            END as status
        FROM DailyStats
        WHERE rn_asc = 1 
           OR (
                rn_desc = 1 
                AND (strftime('%s', waktu) - strftime('%s', first_waktu)) >= 3600
           )
    )
`;

function buildAbsensiQuery(search) {
    const searchTerm = (search || '').trim();
    const hasSearch = searchTerm.length > 0;
    const whereClause = hasSearch ? `WHERE COALESCE(k.nama, 'User ' || a.uid) LIKE ?` : ``;
    const searchParam = hasSearch ? [`%${searchTerm}%`] : [];

    const listSql = `
        ${FILTERED_ABSENSI_CTE}
        SELECT a.id, a.uid, k.nama, a.waktu, a.status
        FROM ValidAbsensi a
        LEFT JOIN karyawan k ON a.uid = k.uid
        ${whereClause}
        ORDER BY a.waktu DESC, a.id DESC
        LIMIT ? OFFSET ?
    `;

    const countSql = `
        ${FILTERED_ABSENSI_CTE}
        SELECT COUNT(*) as total
        FROM ValidAbsensi a
        LEFT JOIN karyawan k ON a.uid = k.uid
        ${whereClause}
    `;

    return { listSql, countSql, searchParam, searchTerm };
}

// Simpan / Proses Log Absensi Sesuai Aturan Jam Masuk & Jam Pulang (>= 1 Jam)
async function saveAttendanceLog(uid, waktu, rawStatus = 'Mesin') {
    const dateStr = waktu.slice(0, 10);
    const dayLogs = await dbAll(
        `SELECT id, waktu, status FROM absensi WHERE uid = ? AND date(waktu) = ? ORDER BY waktu ASC, id ASC`,
        [uid, dateStr]
    );

    if (dayLogs.length === 0) {
        // Belum pernah absen hari ini -> catat sebagai JAM MASUK
        const res = await dbRun(
            `INSERT INTO absensi (uid, waktu, status) VALUES (?, ?, 'Masuk')`,
            [uid, waktu]
        );
        return { action: 'inserted_in', changes: res && res.changes ? res.changes : 1 };
    }

    const firstLog = dayLogs[0];
    const firstMoment = moment(firstLog.waktu, 'YYYY-MM-DD HH:mm:ss');
    const currentMoment = moment(waktu, 'YYYY-MM-DD HH:mm:ss');

    // Jika ada log yang lebih awal dari firstLog yang sudah tercatat
    if (currentMoment.isBefore(firstMoment)) {
        await dbRun(`INSERT INTO absensi (uid, waktu, status) VALUES (?, ?, 'Masuk')`, [uid, waktu]);
        const refreshed = await dbAll(
            `SELECT id, waktu FROM absensi WHERE uid = ? AND date(waktu) = ? ORDER BY waktu ASC, id ASC`,
            [uid, dateStr]
        );
        const newFirst = moment(refreshed[0].waktu, 'YYYY-MM-DD HH:mm:ss');
        let validOutId = null;
        for (let i = 1; i < refreshed.length; i++) {
            const diffSec = moment(refreshed[i].waktu, 'YYYY-MM-DD HH:mm:ss').diff(newFirst, 'seconds');
            if (diffSec >= 3600) {
                validOutId = refreshed[i].id;
            }
        }
        for (let i = 1; i < refreshed.length; i++) {
            if (refreshed[i].id === validOutId) {
                await dbRun(`UPDATE absensi SET status = 'Pulang' WHERE id = ?`, [refreshed[i].id]);
            } else {
                await dbRun(`DELETE FROM absensi WHERE id = ?`, [refreshed[i].id]);
            }
        }
        return { action: 'reordered', changes: 1 };
    }

    const diffSeconds = currentMoment.diff(firstMoment, 'seconds');

    // Kurang dari 1 jam (3600 detik) sejak jam masuk -> DIABAIKAN
    if (diffSeconds < 3600) {
        return { action: 'ignored', changes: 0 };
    }

    // Sudah lewat >= 1 jam sejak jam masuk -> dicatat / diperbarui sebagai JAM PULANG
    if (dayLogs.length === 1) {
        const res = await dbRun(
            `INSERT INTO absensi (uid, waktu, status) VALUES (?, ?, 'Pulang')`,
            [uid, waktu]
        );
        return { action: 'inserted_out', changes: res && res.changes ? res.changes : 1 };
    } else {
        const lastLog = dayLogs[dayLogs.length - 1];
        const lastMoment = moment(lastLog.waktu, 'YYYY-MM-DD HH:mm:ss');

        // Bersihkan log ekstra di tengah jika ada
        if (dayLogs.length > 2) {
            const extraIds = dayLogs.slice(1, -1).map(r => r.id);
            for (const eid of extraIds) {
                await dbRun(`DELETE FROM absensi WHERE id = ?`, [eid]);
            }
        }

        if (currentMoment.isAfter(lastMoment)) {
            const res = await dbRun(
                `UPDATE absensi SET waktu = ?, status = 'Pulang' WHERE id = ?`,
                [waktu, lastLog.id]
            );
            return { action: 'updated_out', changes: res && res.changes ? res.changes : 1 };
        }
        return { action: 'ignored_older_out', changes: 0 };
    }
}

// Dashboard Route - Langsung tampilkan data absensi yang sudah tersimpan di database
app.get('/', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = 50;
        const offset = (page - 1) * limit;
        const search = req.query.search || '';
        const msg = req.query.msg || '';
        const msgType = req.query.type || 'success';

        const { listSql, countSql, searchParam, searchTerm } = buildAbsensiQuery(search);

        const [absensiData, totalRow, karyawanRow, machineConfig] = await Promise.all([
            dbAll(listSql, [...searchParam, limit, offset]),
            dbGet(countSql, searchParam),
            dbGet('SELECT COUNT(*) as total FROM karyawan'),
            getMachineConfig()
        ]);

        const totalAbsensi = totalRow ? totalRow.total : 0;
        const totalPages = Math.ceil(totalAbsensi / limit) || 1;
        const totalKaryawan = karyawanRow ? karyawanRow.total : 0;

        const roleLabel = req.user.role === 'superadmin' ? 'Superadmin' : 'Admin';

        res.render('index', {
            data: absensiData,
            totalKaryawan: totalKaryawan,
            totalAbsensi: totalAbsensi,
            admin: `${req.user.nama} (${roleLabel})`,
            user: req.user,
            msg: msg,
            msgType: msgType,
            currentPage: page,
            totalPages: totalPages,
            searchQuery: searchTerm,
            machineIp: machineConfig.ip,
            machinePort: machineConfig.port
        });
    } catch (err) {
        console.error('Error rendering dashboard:', err);
        res.status(500).send('Terjadi kesalahan saat memuat dashboard.');
    }
});

// API Get Latest Absensi & Stats
app.get('/api/latest-absensi', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = 50;
        const offset = (page - 1) * limit;
        const search = req.query.search || '';

        const { listSql, searchParam } = buildAbsensiQuery(search);
        const rows = await dbAll(listSql, [...searchParam, limit, offset]);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API Dashboard Summary Stats (untuk update UI interaktif tanpa reload penuh)
app.get('/api/dashboard-summary', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = 50;
        const offset = (page - 1) * limit;
        const search = req.query.search || '';

        const { listSql, countSql, searchParam, searchTerm } = buildAbsensiQuery(search);

        const [rows, totalRow, karyawanRow, lastLogRow] = await Promise.all([
            dbAll(listSql, [...searchParam, limit, offset]),
            dbGet(countSql, searchParam),
            dbGet('SELECT COUNT(*) as total FROM karyawan'),
            dbGet('SELECT MAX(waktu) as lastWaktu FROM absensi')
        ]);

        const totalAbsensi = totalRow ? totalRow.total : 0;
        const totalPages = Math.ceil(totalAbsensi / limit) || 1;
        const totalKaryawan = karyawanRow ? karyawanRow.total : 0;

        res.json({
            rows,
            totalAbsensi,
            totalKaryawan,
            currentPage: page,
            totalPages,
            searchQuery: searchTerm,
            lastWaktu: lastLogRow ? lastLogRow.lastWaktu : null
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API Status Progress Sinkronisasi (untuk modal loading bar persentase)
app.get('/api/sync-status', (req, res) => {
    res.json(syncState);
});

// Manual Absensi
app.post('/absen', async (req, res) => {
    try {
        const { uid, status } = req.body;
        const waktu = moment().format('YYYY-MM-DD HH:mm:ss');
        await saveAttendanceLog(uid, waktu, status || 'Manual');
        res.redirect('/');
    } catch (err) {
        console.error('Gagal menyimpan absensi manual:', err);
        res.redirect('/');
    }
});

// CRUD Karyawan - List
app.get('/karyawan', async (req, res) => {
    try {
        const [rows, perusahaanRows, divisiRows, strukturRows] = await Promise.all([
            dbAll(`SELECT uid, nama, COALESCE(jabatan, '') as jabatan, COALESCE(perusahaan, '') as perusahaan, COALESCE(divisi, '') as divisi FROM karyawan ORDER BY CAST(uid AS INTEGER) ASC, uid ASC`),
            dbAll(`SELECT id, nama FROM perusahaan ORDER BY id ASC`),
            dbAll(`SELECT id, nama FROM divisi ORDER BY id ASC`),
            dbAll(`SELECT node_id, tipe, ref_id, nama, parent_node_id, urutan FROM struktur_perusahaan ORDER BY urutan ASC, id ASC`)
        ]);

        const strukturTree = buildStrukturTreeFromRows(strukturRows);

        res.render('karyawan', {
            karyawan: rows,
            perusahaanList: perusahaanRows,
            divisiList: divisiRows,
            strukturTree: strukturTree
        });
    } catch (err) {
        console.error('Gagal memuat data karyawan:', err);
        res.status(500).send('Gagal memuat data karyawan.');
    }
});

// CRUD Karyawan - Add
app.post('/karyawan/add', async (req, res) => {
    try {
        let { uid, nama, jabatan, perusahaan, divisi } = req.body;
        nama = (nama || '').trim();
        jabatan = (jabatan || '').trim();
        perusahaan = (perusahaan || '').trim();
        divisi = (divisi || '').trim();
        uid = (uid || '').trim();

        if (!uid) {
            const row = await dbGet('SELECT MAX(CAST(uid AS INTEGER)) as maxUid FROM karyawan');
            const nextUid = (row && row.maxUid) ? (parseInt(row.maxUid, 10) + 1) : 1;
            uid = String(nextUid);
        }

        await dbRun(
            'INSERT OR REPLACE INTO karyawan (uid, nama, jabatan, perusahaan, divisi) VALUES (?, ?, ?, ?, ?)',
            [uid, nama, jabatan, perusahaan, divisi]
        );
        res.redirect('/karyawan');
    } catch (err) {
        console.error('Gagal menambah karyawan:', err);
        res.redirect('/karyawan');
    }
});

// CRUD Karyawan - Edit (Form)
app.get('/karyawan/edit/:uid', (req, res) => {
    const uid = req.params.uid;
    db.get('SELECT uid, nama, COALESCE(jabatan, "") as jabatan, COALESCE(perusahaan, "") as perusahaan, COALESCE(divisi, "") as divisi FROM karyawan WHERE uid = ?', [uid], (err, row) => {
        if (err || !row) return res.redirect('/karyawan');
        res.render('karyawan_edit', { k: row });
    });
});

// CRUD Karyawan - Update
app.post('/karyawan/edit/:uid', (req, res) => {
    const old_uid = req.params.uid;
    const uid = (req.body.uid || old_uid).trim();
    const nama = (req.body.nama || '').trim();
    const jabatan = (req.body.jabatan || '').trim();
    const perusahaan = (req.body.perusahaan || '').trim();
    const divisi = (req.body.divisi || '').trim();
    db.run(
        'UPDATE karyawan SET uid = ?, nama = ?, jabatan = ?, perusahaan = ?, divisi = ? WHERE uid = ?',
        [uid, nama, jabatan, perusahaan, divisi, old_uid],
        () => {
            res.redirect('/karyawan');
        }
    );
});

// CRUD Karyawan - Delete
app.get('/karyawan/delete/:uid', (req, res) => {
    const uid = req.params.uid;
    db.run('DELETE FROM karyawan WHERE uid = ?', [uid], () => {
        res.redirect('/karyawan');
    });
});

// Helper Membangun Tree Struktur Perusahaan dari Baris Database
function buildStrukturTreeFromRows(rows) {
    const map = new Map();
    const roots = [];

    rows.forEach(r => {
        map.set(r.node_id, {
            nodeId: r.node_id,
            tipe: r.tipe,
            refId: r.ref_id,
            nama: r.nama,
            children: []
        });
    });

    rows.forEach(r => {
        const node = map.get(r.node_id);
        if (r.parent_node_id && map.has(r.parent_node_id)) {
            map.get(r.parent_node_id).children.push(node);
        } else {
            roots.push(node);
        }
    });

    return roots;
}

// Halaman Struktur Perusahaan
app.get('/struktur-perusahaan', async (req, res) => {
    try {
        const msg = req.query.msg || '';
        const msgType = req.query.type || 'success';

        const [perusahaanList, divisiList, strukturRows] = await Promise.all([
            dbAll(`SELECT id, nama FROM perusahaan ORDER BY id ASC`),
            dbAll(`SELECT id, nama FROM divisi ORDER BY id ASC`),
            dbAll(`SELECT node_id, tipe, ref_id, nama, parent_node_id, urutan FROM struktur_perusahaan ORDER BY urutan ASC, id ASC`)
        ]);

        const strukturTree = buildStrukturTreeFromRows(strukturRows);

        res.render('struktur_perusahaan', {
            perusahaanList,
            divisiList,
            strukturTree,
            msg,
            msgType
        });
    } catch (err) {
        console.error('Gagal memuat halaman struktur perusahaan:', err);
        res.status(500).send('Gagal memuat halaman struktur perusahaan.');
    }
});

// Tambah Perusahaan
app.post('/struktur-perusahaan/perusahaan/add', async (req, res) => {
    try {
        const nama = (req.body.nama || '').trim();
        if (!nama) {
            return res.redirect('/struktur-perusahaan?msg=' + encodeURIComponent('Nama perusahaan tidak boleh kosong!') + '&type=error');
        }
        await dbRun(`INSERT INTO perusahaan (nama) VALUES (?)`, [nama]);
        res.redirect('/struktur-perusahaan?msg=' + encodeURIComponent('Perusahaan berhasil ditambahkan!') + '&type=success');
    } catch (err) {
        console.error('Gagal menambah perusahaan:', err);
        res.redirect('/struktur-perusahaan?msg=' + encodeURIComponent('Gagal menambahkan perusahaan.') + '&type=error');
    }
});

// Hapus Perusahaan
app.get('/struktur-perusahaan/perusahaan/delete/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        await dbRun(`DELETE FROM perusahaan WHERE id = ?`, [id]);
        res.redirect('/struktur-perusahaan?msg=' + encodeURIComponent('Perusahaan berhasil dihapus!') + '&type=success');
    } catch (err) {
        console.error('Gagal menghapus perusahaan:', err);
        res.redirect('/struktur-perusahaan?msg=' + encodeURIComponent('Gagal menghapus perusahaan.') + '&type=error');
    }
});

// Tambah Divisi
app.post('/struktur-perusahaan/divisi/add', async (req, res) => {
    try {
        const nama = (req.body.nama || '').trim();
        if (!nama) {
            return res.redirect('/struktur-perusahaan?msg=' + encodeURIComponent('Nama divisi tidak boleh kosong!') + '&type=error');
        }
        await dbRun(`INSERT INTO divisi (nama) VALUES (?)`, [nama]);
        res.redirect('/struktur-perusahaan?msg=' + encodeURIComponent('Divisi berhasil ditambahkan!') + '&type=success');
    } catch (err) {
        console.error('Gagal menambah divisi:', err);
        res.redirect('/struktur-perusahaan?msg=' + encodeURIComponent('Gagal menambahkan divisi.') + '&type=error');
    }
});

// Hapus Divisi
app.get('/struktur-perusahaan/divisi/delete/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        await dbRun(`DELETE FROM divisi WHERE id = ?`, [id]);
        res.redirect('/struktur-perusahaan?msg=' + encodeURIComponent('Divisi berhasil dihapus!') + '&type=success');
    } catch (err) {
        console.error('Gagal menghapus divisi:', err);
        res.redirect('/struktur-perusahaan?msg=' + encodeURIComponent('Gagal menghapus divisi.') + '&type=error');
    }
});

// Simpan Struktur Perusahaan (Hierarki / Tree)
app.post('/api/struktur-perusahaan/save', async (req, res) => {
    try {
        const tree = Array.isArray(req.body.tree) ? req.body.tree : [];
        const flatNodes = [];
        let counter = 0;

        function traverse(nodes, parentNodeId = null) {
            if (!Array.isArray(nodes)) return;
            for (const n of nodes) {
                if (!n || !n.nodeId || !n.nama) continue;
                counter++;
                flatNodes.push({
                    node_id: String(n.nodeId),
                    tipe: n.tipe === 'perusahaan' ? 'perusahaan' : 'divisi',
                    ref_id: parseInt(n.refId, 10) || 0,
                    nama: String(n.nama).trim(),
                    parent_node_id: parentNodeId ? String(parentNodeId) : null,
                    urutan: counter
                });
                if (Array.isArray(n.children) && n.children.length > 0) {
                    traverse(n.children, n.nodeId);
                }
            }
        }

        traverse(tree, null);

        await dbRun(`DELETE FROM struktur_perusahaan`);
        for (const item of flatNodes) {
            await dbRun(
                `INSERT INTO struktur_perusahaan (node_id, tipe, ref_id, nama, parent_node_id, urutan) VALUES (?, ?, ?, ?, ?, ?)`,
                [item.node_id, item.tipe, item.ref_id, item.nama, item.parent_node_id, item.urutan]
            );
        }

        res.json({ success: true, message: 'Struktur perusahaan berhasil disimpan!' });
    } catch (err) {
        console.error('Gagal menyimpan struktur perusahaan:', err);
        res.status(500).json({ success: false, error: 'Gagal menyimpan struktur perusahaan: ' + err.message });
    }
});

// Ekspor Data Karyawan / Beserta Absensi ke Excel (.xlsx)
app.get('/karyawan/export', async (req, res) => {
    try {
        const type = req.query.type || 'karyawan';
        const workbook = XLSX.utils.book_new();

        const karyawanRows = await dbAll(
            `SELECT uid, nama, COALESCE(jabatan, '') as jabatan FROM karyawan ORDER BY CAST(uid AS INTEGER) ASC, uid ASC`
        );

        const dataKaryawanExcel = karyawanRows.map((k, idx) => ({
            'No': idx + 1,
            'ID Karyawan': k.uid,
            'Nama Karyawan': k.nama,
            'Jabatan / Bagian': k.jabatan || '-'
        }));

        const wsKaryawan = XLSX.utils.json_to_sheet(
            dataKaryawanExcel.length > 0
                ? dataKaryawanExcel
                : [{ 'No': '', 'ID Karyawan': '', 'Nama Karyawan': '', 'Jabatan / Bagian': '' }]
        );
        wsKaryawan['!cols'] = [{ wch: 6 }, { wch: 15 }, { wch: 30 }, { wch: 25 }];
        XLSX.utils.book_append_sheet(workbook, wsKaryawan, 'Data Karyawan');

        let filename = `Data_Karyawan_${moment().format('YYYYMMDD_HHmmss')}.xlsx`;

        if (type === 'karyawan_absensi') {
            const absensiSql = `
                ${FILTERED_ABSENSI_CTE}
                SELECT 
                    a.id,
                    a.uid,
                    COALESCE(k.nama, 'User ' || a.uid) as nama,
                    COALESCE(k.jabatan, '') as jabatan,
                    date(a.waktu) as tanggal,
                    time(a.waktu) as jam,
                    a.waktu,
                    a.status
                FROM ValidAbsensi a
                LEFT JOIN karyawan k ON a.uid = k.uid
                ORDER BY a.waktu DESC, a.id DESC
            `;
            const absensiRows = await dbAll(absensiSql);

            const dataAbsensiExcel = absensiRows.map((a, idx) => ({
                'No': idx + 1,
                'ID Karyawan': a.uid,
                'Nama Karyawan': a.nama,
                'Jabatan / Bagian': a.jabatan || '-',
                'Tanggal': a.tanggal,
                'Jam': a.jam,
                'Waktu Lengkap': a.waktu,
                'Status': a.status
            }));

            const wsAbsensi = XLSX.utils.json_to_sheet(
                dataAbsensiExcel.length > 0
                    ? dataAbsensiExcel
                    : [{ 'No': '', 'ID Karyawan': '', 'Nama Karyawan': '', 'Jabatan / Bagian': '', 'Tanggal': '', 'Jam': '', 'Waktu Lengkap': '', 'Status': '' }]
            );
            wsAbsensi['!cols'] = [
                { wch: 6 },
                { wch: 15 },
                { wch: 30 },
                { wch: 25 },
                { wch: 15 },
                { wch: 12 },
                { wch: 22 },
                { wch: 12 }
            ];
            XLSX.utils.book_append_sheet(workbook, wsAbsensi, 'Data Absensi');

            const rekapSql = `
                ${FILTERED_ABSENSI_CTE}
                SELECT 
                    k.uid,
                    k.nama,
                    COALESCE(k.jabatan, '') as jabatan,
                    date(a.waktu) as tanggal,
                    MIN(CASE WHEN a.status = 'Masuk' THEN time(a.waktu) END) as jam_masuk,
                    MAX(CASE WHEN a.status = 'Pulang' THEN time(a.waktu) END) as jam_pulang
                FROM karyawan k
                LEFT JOIN ValidAbsensi a ON k.uid = a.uid
                GROUP BY k.uid, k.nama, k.jabatan, date(a.waktu)
                ORDER BY CAST(k.uid AS INTEGER) ASC, k.uid ASC, tanggal DESC
            `;
            const rekapRows = await dbAll(rekapSql);

            const dataRekapExcel = rekapRows.map((r, idx) => ({
                'No': idx + 1,
                'ID Karyawan': r.uid,
                'Nama Karyawan': r.nama,
                'Jabatan / Bagian': r.jabatan || '-',
                'Tanggal': r.tanggal || '-',
                'Jam Masuk': r.jam_masuk || '-',
                'Jam Pulang': r.jam_pulang || '-'
            }));

            const wsRekap = XLSX.utils.json_to_sheet(
                dataRekapExcel.length > 0
                    ? dataRekapExcel
                    : [{ 'No': '', 'ID Karyawan': '', 'Nama Karyawan': '', 'Jabatan / Bagian': '', 'Tanggal': '', 'Jam Masuk': '', 'Jam Pulang': '' }]
            );
            wsRekap['!cols'] = [
                { wch: 6 },
                { wch: 15 },
                { wch: 30 },
                { wch: 25 },
                { wch: 15 },
                { wch: 15 },
                { wch: 15 }
            ];
            XLSX.utils.book_append_sheet(workbook, wsRekap, 'Rekap Karyawan & Absensi');

            filename = `Data_Karyawan_dan_Absensi_${moment().format('YYYYMMDD_HHmmss')}.xlsx`;
        }

        const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buffer);
    } catch (err) {
        console.error('Gagal ekspor data karyawan:', err);
        res.status(500).send('Gagal mengekspor data ke Excel.');
    }
});

// Endpoint Upload Karyawan ke Mesin (ZKTeco)
app.post('/api/upload-karyawan', async (req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    
    try {
        const users = req.body.users;
        if (!users || !Array.isArray(users) || users.length === 0) {
            res.write(JSON.stringify({ status: 'error', progress: 100, message: 'Tidak ada data karyawan yang dipilih.' }) + '\n');
            return res.end();
        }

        res.write(JSON.stringify({ status: 'running', progress: 10, message: 'Menyiapkan koneksi ke mesin...' }) + '\n');
        
        const config = await getMachineConfig();
        const zkInstance = new ZKLib(config.ip, config.port, 10000, 4000);
        
        await zkInstance.createSocket();
        res.write(JSON.stringify({ status: 'running', progress: 20, message: 'Koneksi berhasil. Memeriksa data karyawan di mesin...' }) + '\n');

        // Ambil daftar user yang sudah ada di mesin untuk mengecek nama yang sama
        const existingMachineNames = new Set();
        try {
            const machineUsers = await zkInstance.getUsers();
            const machineUserList = (machineUsers && Array.isArray(machineUsers.data)) ? machineUsers.data : [];
            for (const mu of machineUserList) {
                if (mu && mu.name) {
                    const normName = String(mu.name).trim().toLowerCase();
                    if (normName) existingMachineNames.add(normName);
                }
            }
        } catch (getUsersErr) {
            console.error('Gagal membaca daftar user dari mesin sebelum upload:', getUsersErr);
        }

        res.write(JSON.stringify({ status: 'running', progress: 30, message: 'Memulai proses upload data karyawan baru...' }) + '\n');

        const total = users.length;
        let successCount = 0;
        let skippedCount = 0;

        for (let i = 0; i < total; i++) {
            const u = users[i];
            const cleanName = String(u.nama || '').trim();
            const normName = cleanName.toLowerCase();

            const pct = 30 + Math.floor(((i + 1) / total) * 60);

            // Jika nama sudah ada di mesin, skip dan lanjutkan ke data nama yang baru
            if (normName && existingMachineNames.has(normName)) {
                skippedCount++;
                res.write(JSON.stringify({ status: 'running', progress: pct, message: `Melewati ${cleanName} (nama sudah ada di mesin) (${i+1}/${total})...` }) + '\n');
                await yieldEventLoop();
                continue;
            }

            try {
                // Konversi uid ke int, fallback jika bukan angka murni, pastikan userid tetap string
                let uidInt = parseInt(u.uid, 10);
                if (isNaN(uidInt)) uidInt = Math.floor(Math.random() * 10000); // Darurat bila uid string bukan angka
                
                await zkInstance.setUser(uidInt, u.uid, cleanName, '', 0, 0);
                successCount++;
                if (normName) existingMachineNames.add(normName);
            } catch (e) {
                console.error(`Gagal upload user ${cleanName} (${u.uid}):`, e);
            }
            
            res.write(JSON.stringify({ status: 'running', progress: pct, message: `Mengupload ${cleanName} (${i+1}/${total})...` }) + '\n');
            await yieldEventLoop();
        }

        try {
            await zkInstance.disconnect();
        } catch (_) {}

        const doneMsg = skippedCount > 0
            ? `Selesai! Berhasil mengupload ${successCount} data baru ke mesin (${skippedCount} nama yang sama dilewati).`
            : `Selesai! Berhasil mengupload ${successCount} dari ${total} data ke mesin.`;

        res.write(JSON.stringify({ status: 'completed', progress: 100, message: doneMsg }) + '\n');
        res.end();
    } catch (err) {
        console.error('Error upload karyawan:', err);
        res.write(JSON.stringify({ status: 'error', progress: 100, message: 'Terjadi kesalahan sistem: ' + err.message }) + '\n');
        res.end();
    }
});


// Cetak Laporan (Ringkas)
app.get('/print', async (req, res) => {
    try {
        const start = req.query.start;
        const end = req.query.end;

        let query = `
            ${FILTERED_ABSENSI_CTE}
            SELECT 
                a.uid, 
                COALESCE(k.nama, 'User ' || a.uid) as nama, 
                date(a.waktu) as tanggal, 
                MIN(CASE WHEN a.status = 'Masuk' THEN time(a.waktu) END) as check_in, 
                MAX(CASE WHEN a.status = 'Pulang' THEN time(a.waktu) END) as check_out
            FROM ValidAbsensi a
            LEFT JOIN karyawan k ON a.uid = k.uid
        `;
        const params = [];

        if (start && end) {
            query += ` WHERE date(a.waktu) >= ? AND date(a.waktu) <= ?`;
            params.push(start, end);
        }

        query += `
            GROUP BY a.uid, k.nama, date(a.waktu)
            ORDER BY tanggal ASC, nama ASC
        `;

        const [rows, allKaryawan] = await Promise.all([
            dbAll(query, params),
            dbAll(`SELECT uid, nama FROM karyawan ORDER BY nama ASC`)
        ]);

        res.render('print', { laporan: rows, semuaKaryawan: allKaryawan, start, end });
    } catch (err) {
        console.error('Error mencetak laporan:', err);
        res.status(500).send('Gagal mencetak laporan.');
    }
});

// Fungsi Asynchronous/Non-Blocking untuk Download Data Karyawan
async function runSyncKaryawan(ip, machinePort = 4370) {
    updateSyncState({
        isSyncing: true,
        type: 'karyawan',
        status: 'running',
        progress: 5,
        total: 0,
        processed: 0,
        added: 0,
        message: 'Menghubungkan ke mesin absensi...'
    });

    const zkInstance = new ZKLib(ip, machinePort, 10000, 4000);
    let socketCreated = false;

    try {
        await zkInstance.createSocket();
        socketCreated = true;

        updateSyncState({
            progress: 25,
            message: 'Mengambil daftar karyawan dari mesin...'
        });

        const users = await zkInstance.getUsers();

        try {
            await zkInstance.disconnect();
            socketCreated = false;
        } catch (_) {}

        const userList = (users && Array.isArray(users.data)) ? users.data : [];
        const total = userList.length;

        updateSyncState({
            progress: 40,
            total: total,
            processed: 0,
            message: total > 0
                ? `Menyimpan ${total} data karyawan ke database...`
                : 'Tidak ada data karyawan di mesin.'
        });

        let savedCount = 0;
        const chunkSize = 25;

        for (let i = 0; i < total; i += chunkSize) {
            const chunk = userList.slice(i, i + chunkSize);
            for (const user of chunk) {
                const uid = String(user.userId || user.uid || '').trim();
                if (!uid) continue;
                const nama = (user.name && String(user.name).trim()) ? String(user.name).trim() : `User ${uid}`;
                // Pertahankan jabatan yang sudah ada bila karyawan pernah diinput/diedit
                await dbRun(
                    `INSERT INTO karyawan (uid, nama, jabatan)
                     VALUES (?, ?, COALESCE((SELECT jabatan FROM karyawan WHERE uid = ?), ''))
                     ON CONFLICT(uid) DO UPDATE SET nama = excluded.nama`,
                    [uid, nama, uid]
                );
                savedCount++;
            }

            const processed = Math.min(i + chunk.length, total);
            const pct = total > 0 ? Math.min(95, Math.round(40 + ((processed / total) * 55))) : 95;
            updateSyncState({
                progress: pct,
                processed: processed,
                added: savedCount,
                message: `Menyimpan data karyawan (${processed}/${total})...`
            });

            // Beri ruang ke event loop agar request halaman lain tetap responsif
            await yieldEventLoop();
        }

        const msg = `Data karyawan berhasil didownload dan disinkronisasi (${savedCount} karyawan)!`;
        updateSyncState({
            isSyncing: false,
            status: 'completed',
            progress: 100,
            processed: total,
            added: savedCount,
            message: msg
        });

        return { success: true, message: msg, total: savedCount };
    } catch (e) {
        if (socketCreated) {
            try { await zkInstance.disconnect(); } catch (_) {}
        }
        const errMsg = e && e.message ? `Gagal mendownload data karyawan: ${e.message}` : 'Gagal koneksi ke mesin absensi.';
        updateSyncState({
            isSyncing: false,
            status: 'error',
            progress: 100,
            message: errMsg
        });
        return { success: false, message: errMsg };
    }
}

// Fungsi Asynchronous/Non-Blocking & Incremental untuk Download Data Absensi
async function runSyncAbsensi(ip, machinePort = 4370) {
    updateSyncState({
        isSyncing: true,
        type: 'absensi',
        status: 'running',
        progress: 5,
        total: 0,
        processed: 0,
        added: 0,
        message: 'Mengecek data terakhir di database...'
    });

    const zkInstance = new ZKLib(ip, machinePort, 10000, 4000);
    let socketCreated = false;

    try {
        // 1. Ambil semua log yang sudah ada untuk incremental sync (menghindari bug skip data karyawan baru)
        const existingLogs = await dbAll(`SELECT uid, waktu FROM absensi`);
        const existingLogsSet = new Set(existingLogs.map(r => `${r.uid}|${r.waktu}`));

        updateSyncState({
            progress: 15,
            message: 'Menghubungkan ke mesin absensi...'
        });

        await zkInstance.createSocket();
        socketCreated = true;

        updateSyncState({
            progress: 30,
            message: 'Mengambil log absensi dari mesin...'
        });

        const logs = await zkInstance.getAttendances();

        // Segera tutup koneksi socket mesin agar tidak menahan koneksi
        try {
            await zkInstance.disconnect();
            socketCreated = false;
        } catch (_) {}

        const allLogs = (logs && Array.isArray(logs.data)) ? logs.data : [];

        updateSyncState({
            progress: 45,
            message: 'Memfilter log absensi baru (incremental sync)...'
        });

        // 2. Filter hanya log baru (Incremental & perbaikan masa depan)
        const seenKeys = new Set();
        const candidateLogs = [];
        const nowStr = moment().format('YYYY-MM-DD HH:mm:ss');

        for (const log of allLogs) {
            if (!log || !log.recordTime) continue;
            const uid = String(log.deviceUserId || log.userId || log.uid || '').trim();
            if (!uid) continue;

            const m = moment(log.recordTime);
            if (!m.isValid()) continue;
            const waktu = m.format('YYYY-MM-DD HH:mm:ss');

            // Abaikan log masa depan dari mesin yang salah waktu
            if (waktu > nowStr) continue;

            const uniqueKey = `${uid}|${waktu}`;
            if (existingLogsSet.has(uniqueKey)) continue;
            if (seenKeys.has(uniqueKey)) continue;
            seenKeys.add(uniqueKey);

            candidateLogs.push({ uid, waktu, status: 'Mesin' });
        }

        // Urutkan log baru secara kronologis agar evaluasi Jam Masuk & Jam Pulang (>= 1 jam) akurat
        candidateLogs.sort((a, b) => a.waktu.localeCompare(b.waktu));

        const totalNew = candidateLogs.length;

        if (totalNew === 0) {
            const msg = 'Data absensi sudah paling mutakhir (tidak ada data baru untuk didownload).';
            updateSyncState({
                isSyncing: false,
                status: 'completed',
                progress: 100,
                total: 0,
                processed: 0,
                added: 0,
                message: msg
            });
            return { success: true, message: msg, added: 0, total: 0 };
        }

        updateSyncState({
            progress: 50,
            total: totalNew,
            processed: 0,
            message: `Memproses ${totalNew} data absensi baru...`
        });

        // 3. Simpan log baru secara bertahap sesuai aturan Jam Masuk & Pulang (>= 1 jam)
        let insertedCount = 0;
        const chunkSize = 50;

        for (let i = 0; i < totalNew; i += chunkSize) {
            const chunk = candidateLogs.slice(i, i + chunkSize);

            for (const item of chunk) {
                const result = await saveAttendanceLog(item.uid, item.waktu, item.status);
                if (result && result.changes > 0) {
                    insertedCount++;
                }
            }

            const processed = Math.min(i + chunk.length, totalNew);
            const pct = Math.min(95, Math.round(50 + ((processed / totalNew) * 45)));
            updateSyncState({
                progress: pct,
                processed: processed,
                added: insertedCount,
                message: `Memproses data absensi baru (${processed}/${totalNew})...`
            });

            await yieldEventLoop();
        }

        const msg = `Data absensi berhasil didownload (${insertedCount} log masuk/pulang disimpan)!`;
        updateSyncState({
            isSyncing: false,
            status: 'completed',
            progress: 100,
            total: totalNew,
            processed: totalNew,
            added: insertedCount,
            message: msg
        });

        return { success: true, message: msg, added: insertedCount, total: totalNew };
    } catch (e) {
        if (socketCreated) {
            try { await zkInstance.disconnect(); } catch (_) {}
        }
        const errMsg = e && e.message ? `Gagal mendownload data absensi: ${e.message}` : 'Gagal koneksi ke mesin absensi.';
        updateSyncState({
            isSyncing: false,
            status: 'error',
            progress: 100,
            message: errMsg
        });
        return { success: false, message: errMsg };
    }
}

// Sync Karyawan dari Mesin (ZKTeco / Solution)
app.get('/api/sync-karyawan', async (req, res) => {
    const config = await getMachineConfig();
    const ip = req.query.ip || config.ip;
    const machinePort = parseInt(req.query.port, 10) || config.port;
    const isBackground = req.query.background === '1' || req.query.async === '1';

    if (syncState.isSyncing) {
        return res.json({
            success: false,
            alreadyRunning: true,
            message: 'Proses sinkronisasi lain sedang berjalan, harap tunggu sampai selesai.',
            state: syncState
        });
    }

    if (isBackground) {
        runSyncKaryawan(ip, machinePort);
        return res.json({
            success: true,
            started: true,
            message: 'Proses download data karyawan dimulai.',
            state: syncState
        });
    }

    const result = await runSyncKaryawan(ip, machinePort);
    res.json(result);
});

// Sync Absensi dari Mesin (Manual & Increincremental)
app.get('/api/sync-absensi', async (req, res) => {
    const config = await getMachineConfig();
    const ip = req.query.ip || config.ip;
    const machinePort = parseInt(req.query.port, 10) || config.port;
    const isBackground = req.query.background === '1' || req.query.async === '1';

    if (syncState.isSyncing) {
        return res.json({
            success: false,
            alreadyRunning: true,
            message: 'Proses sinkronisasi lain sedang berjalan, harap tunggu sampai selesai.',
            state: syncState
        });
    }

    if (isBackground) {
        runSyncAbsensi(ip, machinePort);
        return res.json({
            success: true,
            started: true,
            message: 'Proses download data absensi dimulai.',
            state: syncState
        });
    }

    const result = await runSyncAbsensi(ip, machinePort);
    res.json(result);
});

// Cek Status Mesin (Non-blocking & tidak bentrok saat sedang sync)
let isCheckingMachineStatus = false;
let lastMachineStatus = 'Offline';
let lastMachineCheckTime = 0;

app.get('/api/machine-status', async (req, res) => {
    const config = await getMachineConfig();
    const ip = req.query.ip || config.ip;
    const machinePort = parseInt(req.query.port, 10) || config.port;

    // Jika sedang sinkronisasi dengan mesin, jangan buka socket baru agar tidak bentrok/blocking
    if (syncState.isSyncing) {
        return res.json({ status: 'Online', syncing: true, ip, port: machinePort });
    }

    const now = Date.now();
    if (isCheckingMachineStatus || (now - lastMachineCheckTime < 5000)) {
        return res.json({ status: lastMachineStatus, ip, port: machinePort });
    }

    isCheckingMachineStatus = true;
    const zkInstance = new ZKLib(ip, machinePort, 3000, 3000);
    try {
        await zkInstance.createSocket();
        await zkInstance.disconnect();
        lastMachineStatus = 'Online';
        lastMachineCheckTime = Date.now();
        res.json({ status: 'Online', ip, port: machinePort });
    } catch (e) {
        lastMachineStatus = 'Offline';
        lastMachineCheckTime = Date.now();
        res.json({ status: 'Offline', ip, port: machinePort });
    } finally {
        isCheckingMachineStatus = false;
    }
});

app.listen(port, () => {
    console.log(`Server berjalan di http://localhost:${port}`);
});
