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
app.use(express.static(path.join(__dirname, 'public')));

// Setup Database SQLite
const db = new sqlite3.Database('./absensi.db', (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        
        // Agar schema tidak berantakan dengan database lama, kita drop dan create ulang khusus di task ini.
        db.serialize(() => {
            db.run(`DROP TABLE IF EXISTS absensi`);
            db.run(`DROP TABLE IF EXISTS karyawan`);
            
            // Table Karyawan (uid is the deviceUserId/userId)
            db.run(`CREATE TABLE IF NOT EXISTS karyawan (
                uid TEXT PRIMARY KEY,
                nama TEXT NOT NULL
            )`);
            
            // Table Absensi
            db.run(`CREATE TABLE IF NOT EXISTS absensi (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uid TEXT NOT NULL,
                waktu TEXT NOT NULL,
                status TEXT NOT NULL,
                FOREIGN KEY (uid) REFERENCES karyawan(uid)
            )`);
        });
    }
});

// Dashboard Route
app.get('/', (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 50;
    const offset = (page - 1) * limit;

    const query = `
        SELECT a.id, k.nama, a.waktu, 
        CASE 
            WHEN a.status = 'Mesin' THEN 
                CASE 
                    WHEN (SELECT COUNT(*) FROM absensi a2 WHERE a2.uid = a.uid AND date(a2.waktu) = date(a.waktu) AND a2.waktu <= a.waktu) % 2 = 1 THEN 'Masuk' 
                    ELSE 'Pulang' 
                END
            ELSE a.status 
        END as status
        FROM absensi a 
        LEFT JOIN karyawan k ON a.uid = k.uid 
        ORDER BY a.waktu DESC 
        LIMIT ? OFFSET ?
    `;

    db.all(query, [limit, offset], (err, absensiData) => {
        if (err) throw err;
        db.get('SELECT COUNT(*) as total FROM absensi', [], (err, totalRow) => {
            if (err) throw err;
            const totalAbsensi = totalRow ? totalRow.total : 0;
            const totalPages = Math.ceil(totalAbsensi / limit) || 1;

            db.get('SELECT COUNT(*) as total FROM karyawan', [], (err, row) => {
                if (err) throw err;
                const totalKaryawan = row ? row.total : 0;
                res.render('index', { 
                    data: absensiData,
                    totalKaryawan: totalKaryawan,
                    admin: 'Julio (Admin)',
                    currentPage: page,
                    totalPages: totalPages
                });
            });
        });
    });
});

// API Get Latest Absensi (Realtime Update)
app.get('/api/latest-absensi', (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = 50;
    const offset = (page - 1) * limit;

    const query = `
        SELECT a.id, k.nama, a.waktu, 
        CASE 
            WHEN a.status = 'Mesin' THEN 
                CASE 
                    WHEN (SELECT COUNT(*) FROM absensi a2 WHERE a2.uid = a.uid AND date(a2.waktu) = date(a.waktu) AND a2.waktu <= a.waktu) % 2 = 1 THEN 'Masuk' 
                    ELSE 'Pulang' 
                END
            ELSE a.status 
        END as status
        FROM absensi a 
        LEFT JOIN karyawan k ON a.uid = k.uid 
        ORDER BY a.waktu DESC 
        LIMIT ? OFFSET ?
    `;

    db.all(query, [limit, offset], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Manual Absensi 
app.post('/absen', (req, res) => {
    const { uid, status } = req.body;
    const waktu = moment().format('YYYY-MM-DD HH:mm:ss');
    db.run(`INSERT INTO absensi (uid, waktu, status) VALUES (?, ?, ?)`, [uid, waktu, status], (err) => {
        res.redirect('/');
    });
});

// CRUD Karyawan - List
app.get('/karyawan', (req, res) => {
    db.all('SELECT * FROM karyawan ORDER BY uid ASC', [], (err, rows) => {
        if (err) throw err;
        res.render('karyawan', { karyawan: rows });
    });
});

// CRUD Karyawan - Add
app.post('/karyawan/add', (req, res) => {
    const { uid, nama } = req.body;
    db.run('INSERT INTO karyawan (uid, nama) VALUES (?, ?)', [uid, nama], (err) => {
        res.redirect('/karyawan');
    });
});

// CRUD Karyawan - Edit (Form)
app.get('/karyawan/edit/:uid', (req, res) => {
    const uid = req.params.uid;
    db.get('SELECT * FROM karyawan WHERE uid = ?', [uid], (err, row) => {
        if (err) throw err;
        res.render('karyawan_edit', { k: row });
    });
});

// CRUD Karyawan - Update
app.post('/karyawan/edit/:uid', (req, res) => {
    const old_uid = req.params.uid;
    const { uid, nama } = req.body;
    db.run('UPDATE karyawan SET uid = ?, nama = ? WHERE uid = ?', [uid, nama, old_uid], (err) => {
        res.redirect('/karyawan');
    });
});

// CRUD Karyawan - Delete
app.get('/karyawan/delete/:uid', (req, res) => {
    const uid = req.params.uid;
    db.run('DELETE FROM karyawan WHERE uid = ?', [uid], (err) => {
        res.redirect('/karyawan');
    });
});

// Cetak Laporan (Ringkas)
app.get('/print', (req, res) => {
    const start = req.query.start;
    const end = req.query.end;

    let query = `
        SELECT k.nama, date(a.waktu) as tanggal, MIN(time(a.waktu)) as check_in, MAX(time(a.waktu)) as check_out
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
        ORDER BY tanggal DESC, k.nama ASC
    `;

    db.all(query, params, (err, rows) => {
        if (err) throw err;
        res.render('print', { laporan: rows, start, end });
    });
});

// Sync Karyawan dari Mesin (ZKTeco / Solution)
app.get('/api/sync-karyawan', async (req, res) => {
    const ip = req.query.ip || '192.168.0.11'; 
    const zkInstance = new ZKLib(ip, 4370, 10000, 4000);
    try {
        await zkInstance.createSocket();
        const users = await zkInstance.getUsers();
        
        if (users && users.data) {
            for (let user of users.data) {
                const uid = user.userId;
                const nama = user.name || \`User \${uid}\`;
                
                await new Promise((resolve) => {
                    db.run('INSERT OR REPLACE INTO karyawan (uid, nama) VALUES (?, ?)', 
                        [uid, nama], resolve);
                });
            }
        }
        
        await zkInstance.disconnect();
        res.json({ success: true, message: 'Data karyawan berhasil ditarik dan disinkronisasi!' });
    } catch (e) {
        res.json({ success: false, message: e.message || 'Gagal koneksi ke mesin absensi.' });
    }
});

// Sync Absensi dari Mesin
app.get('/api/sync-absensi', async (req, res) => {
    const ip = req.query.ip || '192.168.0.11';
    const zkInstance = new ZKLib(ip, 4370, 10000, 4000);
    try {
        await zkInstance.createSocket();
        const logs = await zkInstance.getAttendances();
        
        if (logs && logs.data) {
            for (let log of logs.data) {
                const uid = log.deviceUserId;
                const waktu = moment(log.recordTime).format('YYYY-MM-DD HH:mm:ss');
                const status = 'Mesin';
                
                await new Promise((resolve) => {
                    db.run('INSERT INTO absensi (uid, waktu, status) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM absensi WHERE uid=? AND waktu=?)', 
                                [uid, waktu, status, uid, waktu], resolve);
                });
            }
        }
        
        await zkInstance.disconnect();
        res.json({ success: true, message: 'Data absensi berhasil ditarik!' });
    } catch (e) {
        res.json({ success: false, message: e.message || 'Gagal koneksi ke mesin absensi.' });
    }
});

// Cek Status Mesin
app.get('/api/machine-status', async (req, res) => {
    const ip = req.query.ip || '192.168.0.11';
    const zkInstance = new ZKLib(ip, 4370, 3000, 3000);
    try {
        await zkInstance.createSocket();
        await zkInstance.disconnect();
        res.json({ status: 'Online' });
    } catch(e) {
        res.json({ status: 'Offline' });
    }
});

app.listen(port, () => {
    console.log(\`Server berjalan di http://localhost:\${port}\`);
});
