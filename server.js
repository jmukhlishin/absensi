const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const moment = require('moment');
const crypto = require('crypto');
const ZKLib = require('node-zklib');

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
                                ['Julio', 'admin', 'admin123', 'admin']
                            );
                        }
                    });
                });
            });

            // Table Karyawan (uid is the deviceUserId/userId) - Persisten tanpa DROP TABLE
            db.run(`CREATE TABLE IF NOT EXISTS karyawan (
                uid TEXT PRIMARY KEY,
                nama TEXT NOT NULL,
                jabatan TEXT DEFAULT ''
            )`);

            // Pastikan kolom jabatan tersedia untuk database yang sudah ada sebelumnya
            db.all(`PRAGMA table_info(karyawan)`, (pragmaErr, columns) => {
                if (!pragmaErr && Array.isArray(columns)) {
                    const hasJabatan = columns.some(col => col.name === 'jabatan');
                    if (!hasJabatan) {
                        db.run(`ALTER TABLE karyawan ADD COLUMN jabatan TEXT DEFAULT ''`);
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

            // Index untuk mempercepat query dashboard dan pengecekan sync incremental
            db.run(`CREATE INDEX IF NOT EXISTS idx_absensi_waktu ON absensi(waktu DESC)`);
            db.run(`CREATE INDEX IF NOT EXISTS idx_absensi_uid_waktu ON absensi(uid, waktu)`);
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

        const [absensiData, totalRow, karyawanRow] = await Promise.all([
            dbAll(listSql, [...searchParam, limit, offset]),
            dbGet(countSql, searchParam),
            dbGet('SELECT COUNT(*) as total FROM karyawan')
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
            searchQuery: searchTerm
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
app.get('/karyawan', (req, res) => {
    db.all('SELECT uid, nama, COALESCE(jabatan, "") as jabatan FROM karyawan ORDER BY CAST(uid AS INTEGER) ASC, uid ASC', [], (err, rows) => {
        if (err) return res.status(500).send('Gagal memuat data karyawan.');
        res.render('karyawan', { karyawan: rows });
    });
});

// CRUD Karyawan - Add
app.post('/karyawan/add', async (req, res) => {
    try {
        let { uid, nama, jabatan } = req.body;
        nama = (nama || '').trim();
        jabatan = (jabatan || '').trim();
        uid = (uid || '').trim();

        if (!uid) {
            const row = await dbGet('SELECT MAX(CAST(uid AS INTEGER)) as maxUid FROM karyawan');
            const nextUid = (row && row.maxUid) ? (parseInt(row.maxUid, 10) + 1) : 1;
            uid = String(nextUid);
        }

        await dbRun('INSERT OR REPLACE INTO karyawan (uid, nama, jabatan) VALUES (?, ?, ?)', [uid, nama, jabatan]);
        res.redirect('/karyawan');
    } catch (err) {
        console.error('Gagal menambah karyawan:', err);
        res.redirect('/karyawan');
    }
});

// CRUD Karyawan - Edit (Form)
app.get('/karyawan/edit/:uid', (req, res) => {
    const uid = req.params.uid;
    db.get('SELECT uid, nama, COALESCE(jabatan, "") as jabatan FROM karyawan WHERE uid = ?', [uid], (err, row) => {
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
    db.run('UPDATE karyawan SET uid = ?, nama = ?, jabatan = ? WHERE uid = ?', [uid, nama, jabatan, old_uid], () => {
        res.redirect('/karyawan');
    });
});

// CRUD Karyawan - Delete
app.get('/karyawan/delete/:uid', (req, res) => {
    const uid = req.params.uid;
    db.run('DELETE FROM karyawan WHERE uid = ?', [uid], () => {
        res.redirect('/karyawan');
    });
});

// Cetak Laporan (Ringkas)
app.get('/print', (req, res) => {
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

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).send('Gagal mencetak laporan.');
        res.render('print', { laporan: rows, start, end });
    });
});

// Fungsi Asynchronous/Non-Blocking untuk Download Data Karyawan
async function runSyncKaryawan(ip) {
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

    const zkInstance = new ZKLib(ip, 4370, 10000, 4000);
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
            const pct = total > 0 ? Math.min(95, Math.round(40 + (processed / total) * 55)) : 95;
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
async function runSyncAbsensi(ip) {
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

    const zkInstance = new ZKLib(ip, 4370, 10000, 4000);
    let socketCreated = false;

    try {
        // 1. Ambil timestamp/ID terakhir yang sudah tersimpan di database untuk incremental sync
        const lastRecord = await dbGet(`SELECT MAX(waktu) as lastWaktu, MAX(id) as lastId FROM absensi`);
        const lastWaktu = (lastRecord && lastRecord.lastWaktu) ? lastRecord.lastWaktu : null;

        // Ambil daftar UID pada detik terakhir (jika ada beberapa tap di detik yang sama persis)
        const existingAtLastWaktu = new Set();
        if (lastWaktu) {
            const rowsAtLast = await dbAll(`SELECT uid FROM absensi WHERE waktu = ?`, [lastWaktu]);
            rowsAtLast.forEach((r) => existingAtLastWaktu.add(String(r.uid)));
        }

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

        // 2. Filter hanya log baru setelah data terakhir di database (Incremental)
        const seenKeys = new Set();
        const candidateLogs = [];

        for (const log of allLogs) {
            if (!log || !log.recordTime) continue;
            const uid = String(log.deviceUserId || log.userId || log.uid || '').trim();
            if (!uid) continue;

            const m = moment(log.recordTime);
            if (!m.isValid()) continue;
            const waktu = m.format('YYYY-MM-DD HH:mm:ss');

            // Hanya ambil log dengan timestamp setelah data terakhir di DB
            if (lastWaktu) {
                if (waktu < lastWaktu) continue;
                if (waktu === lastWaktu && existingAtLastWaktu.has(uid)) continue;
            }

            const uniqueKey = `${uid}|${waktu}`;
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
            const pct = Math.min(95, Math.round(50 + (processed / totalNew) * 45));
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
    const ip = req.query.ip || '192.168.0.11';
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
        runSyncKaryawan(ip);
        return res.json({
            success: true,
            started: true,
            message: 'Proses download data karyawan dimulai.',
            state: syncState
        });
    }

    const result = await runSyncKaryawan(ip);
    res.json(result);
});

// Sync Absensi dari Mesin (Manual & Incremental)
app.get('/api/sync-absensi', async (req, res) => {
    const ip = req.query.ip || '192.168.0.11';
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
        runSyncAbsensi(ip);
        return res.json({
            success: true,
            started: true,
            message: 'Proses download data absensi dimulai.',
            state: syncState
        });
    }

    const result = await runSyncAbsensi(ip);
    res.json(result);
});

// Cek Status Mesin (Non-blocking & tidak bentrok saat sedang sync)
let isCheckingMachineStatus = false;
let lastMachineStatus = 'Offline';
let lastMachineCheckTime = 0;

app.get('/api/machine-status', async (req, res) => {
    const ip = req.query.ip || '192.168.0.11';

    // Jika sedang sinkronisasi dengan mesin, jangan buka socket baru agar tidak bentrok/blocking
    if (syncState.isSyncing) {
        return res.json({ status: 'Online', syncing: true });
    }

    const now = Date.now();
    if (isCheckingMachineStatus || (now - lastMachineCheckTime < 5000)) {
        return res.json({ status: lastMachineStatus });
    }

    isCheckingMachineStatus = true;
    const zkInstance = new ZKLib(ip, 4370, 3000, 3000);
    try {
        await zkInstance.createSocket();
        await zkInstance.disconnect();
        lastMachineStatus = 'Online';
        lastMachineCheckTime = Date.now();
        res.json({ status: 'Online' });
    } catch (e) {
        lastMachineStatus = 'Offline';
        lastMachineCheckTime = Date.now();
        res.json({ status: 'Offline' });
    } finally {
        isCheckingMachineStatus = false;
    }
});

app.listen(port, () => {
    console.log(`Server berjalan di http://localhost:${port}`);
});
