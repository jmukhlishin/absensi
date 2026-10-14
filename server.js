const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const moment = require('moment');
const ZKLib = require('node-zklib');

const app = express();
const port = process.env.PORT || 3000;

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

            // Table Karyawan (uid is the deviceUserId/userId) - Persisten tanpa DROP TABLE
            db.run(`CREATE TABLE IF NOT EXISTS karyawan (
                uid TEXT PRIMARY KEY,
                nama TEXT NOT NULL
            )`);

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

// Query daftar absensi dengan status Masuk/Pulang
const ABSENSI_LIST_QUERY = `
    SELECT a.id, a.uid, k.nama, a.waktu, 
    CASE 
        WHEN a.status = 'Mesin' THEN 
            CASE 
                WHEN (
                    SELECT COUNT(*) 
                    FROM absensi a2 
                    WHERE a2.uid = a.uid 
                      AND date(a2.waktu) = date(a.waktu) 
                      AND (a2.waktu < a.waktu OR (a2.waktu = a.waktu AND a2.id <= a.id))
                ) % 2 = 1 THEN 'Masuk' 
                ELSE 'Pulang' 
            END
        ELSE a.status 
    END as status
    FROM absensi a 
    LEFT JOIN karyawan k ON a.uid = k.uid 
    ORDER BY a.waktu DESC, a.id DESC 
    LIMIT ? OFFSET ?
`;

// Dashboard Route - Langsung tampilkan data absensi yang sudah tersimpan di database
app.get('/', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = 50;
        const offset = (page - 1) * limit;

        const [absensiData, totalRow, karyawanRow] = await Promise.all([
            dbAll(ABSENSI_LIST_QUERY, [limit, offset]),
            dbGet('SELECT COUNT(*) as total FROM absensi'),
            dbGet('SELECT COUNT(*) as total FROM karyawan')
        ]);

        const totalAbsensi = totalRow ? totalRow.total : 0;
        const totalPages = Math.ceil(totalAbsensi / limit) || 1;
        const totalKaryawan = karyawanRow ? karyawanRow.total : 0;

        res.render('index', {
            data: absensiData,
            totalKaryawan: totalKaryawan,
            totalAbsensi: totalAbsensi,
            admin: 'Julio (Admin)',
            currentPage: page,
            totalPages: totalPages
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

        const rows = await dbAll(ABSENSI_LIST_QUERY, [limit, offset]);
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

        const [rows, totalRow, karyawanRow, lastLogRow] = await Promise.all([
            dbAll(ABSENSI_LIST_QUERY, [limit, offset]),
            dbGet('SELECT COUNT(*) as total FROM absensi'),
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
app.post('/absen', (req, res) => {
    const { uid, status } = req.body;
    const waktu = moment().format('YYYY-MM-DD HH:mm:ss');
    db.run(`INSERT INTO absensi (uid, waktu, status) VALUES (?, ?, ?)`, [uid, waktu, status], () => {
        res.redirect('/');
    });
});

// CRUD Karyawan - List
app.get('/karyawan', (req, res) => {
    db.all('SELECT * FROM karyawan ORDER BY CAST(uid AS INTEGER) ASC, uid ASC', [], (err, rows) => {
        if (err) return res.status(500).send('Gagal memuat data karyawan.');
        res.render('karyawan', { karyawan: rows });
    });
});

// CRUD Karyawan - Add
app.post('/karyawan/add', (req, res) => {
    const { uid, nama } = req.body;
    db.run('INSERT OR REPLACE INTO karyawan (uid, nama) VALUES (?, ?)', [uid, nama], () => {
        res.redirect('/karyawan');
    });
});

// CRUD Karyawan - Edit (Form)
app.get('/karyawan/edit/:uid', (req, res) => {
    const uid = req.params.uid;
    db.get('SELECT * FROM karyawan WHERE uid = ?', [uid], (err, row) => {
        if (err) return res.status(500).send('Gagal memuat data karyawan.');
        res.render('karyawan_edit', { k: row });
    });
});

// CRUD Karyawan - Update
app.post('/karyawan/edit/:uid', (req, res) => {
    const old_uid = req.params.uid;
    const { uid, nama } = req.body;
    db.run('UPDATE karyawan SET uid = ?, nama = ? WHERE uid = ?', [uid, nama, old_uid], () => {
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
        SELECT a.uid, COALESCE(k.nama, 'User ' || a.uid) as nama, date(a.waktu) as tanggal, MIN(time(a.waktu)) as check_in, MAX(time(a.waktu)) as check_out
        FROM absensi a
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
                await dbRun('INSERT OR REPLACE INTO karyawan (uid, nama) VALUES (?, ?)', [uid, nama]);
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
        const newLogs = [];

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

            newLogs.push({ uid, waktu, status: 'Mesin' });
        }

        // Urutkan log baru secara kronologis agar urutan ID sesuai waktu
        newLogs.sort((a, b) => a.waktu.localeCompare(b.waktu));

        const totalNew = newLogs.length;

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
            message: `Menyimpan ${totalNew} data absensi baru...`
        });

        // 3. Simpan log baru secara bertahap (chunking + yieldEventLoop) agar server tidak blocking
        let insertedCount = 0;
        const chunkSize = 50;

        for (let i = 0; i < totalNew; i += chunkSize) {
            const chunk = newLogs.slice(i, i + chunkSize);

            for (const item of chunk) {
                const result = await dbRun(
                    `INSERT INTO absensi (uid, waktu, status)
                     SELECT ?, ?, ?
                     WHERE NOT EXISTS (SELECT 1 FROM absensi WHERE uid = ? AND waktu = ?)`,
                    [item.uid, item.waktu, item.status, item.uid, item.waktu]
                );
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
                message: `Menyimpan data absensi baru (${processed}/${totalNew})...`
            });

            await yieldEventLoop();
        }

        const msg = `Data absensi berhasil didownload (${insertedCount} data baru ditambahkan)!`;
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
