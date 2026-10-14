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
        
        // Table Absensi
        db.run(`CREATE TABLE IF NOT EXISTS absensi (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nama TEXT NOT NULL,
            waktu TEXT NOT NULL,
            status TEXT NOT NULL
        )`);
        
        // Table Karyawan
        db.run(`CREATE TABLE IF NOT EXISTS karyawan (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uid INTEGER,
            nama TEXT NOT NULL
        )`);
    }
});

// Dashboard Route
app.get('/', (req, res) => {
    db.all('SELECT * FROM absensi ORDER BY waktu DESC LIMIT 10', [], (err, absensiData) => {
        if (err) throw err;
        db.get('SELECT COUNT(*) as total FROM karyawan', [], (err, row) => {
            if (err) throw err;
            const totalKaryawan = row ? row.total : 0;
            res.render('index', { 
                data: absensiData,
                totalKaryawan: totalKaryawan,
                admin: 'Julio (Admin)' 
            });
        });
    });
});

// Manual Absensi 
app.post('/absen', (req, res) => {
    const { nama, status } = req.body;
    const waktu = moment().format('YYYY-MM-DD HH:mm:ss');
    db.run(`INSERT INTO absensi (nama, waktu, status) VALUES (?, ?, ?)`, [nama, waktu, status], (err) => {
        res.redirect('/');
    });
});

// CRUD Karyawan - List
app.get('/karyawan', (req, res) => {
    db.all('SELECT * FROM karyawan ORDER BY id DESC', [], (err, rows) => {
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
app.get('/karyawan/edit/:id', (req, res) => {
    const id = req.params.id;
    db.get('SELECT * FROM karyawan WHERE id = ?', [id], (err, row) => {
        if (err) throw err;
        res.render('karyawan_edit', { k: row });
    });
});

// CRUD Karyawan - Update
app.post('/karyawan/edit/:id', (req, res) => {
    const id = req.params.id;
    const { uid, nama } = req.body;
    db.run('UPDATE karyawan SET uid = ?, nama = ? WHERE id = ?', [uid, nama, id], (err) => {
        res.redirect('/karyawan');
    });
});

// CRUD Karyawan - Delete
app.get('/karyawan/delete/:id', (req, res) => {
    const id = req.params.id;
    db.run('DELETE FROM karyawan WHERE id = ?', [id], (err) => {
        res.redirect('/karyawan');
    });
});

// Cetak Laporan (Ringkas)
app.get('/print', (req, res) => {
    // Process check_in and check_out per date per user
    const query = `
        SELECT nama, date(waktu) as tanggal, MIN(time(waktu)) as check_in, MAX(time(waktu)) as check_out
        FROM absensi
        GROUP BY nama, date(waktu)
        ORDER BY tanggal DESC, nama ASC
    `;
    db.all(query, [], (err, rows) => {
        if (err) throw err;
        res.render('print', { laporan: rows });
    });
});

// Sync from Machine (ZKTeco / Solution)
app.get('/api/sync-machine', async (req, res) => {
    const ip = req.query.ip || '192.168.1.201'; // IP Mesin
    const zkInstance = new ZKLib(ip, 4370, 10000, 4000);
    try {
        await zkInstance.createSocket();
        const logs = await zkInstance.getAttendances();
        const users = await zkInstance.getUsers();
        
        if (logs && logs.data) {
            for (let log of logs.data) {
                const user = users.data.find(u => u.uid === log.deviceUserId);
                const nama = user ? user.name : 'UID:' + log.deviceUserId;
                const waktu = moment(log.recordTime).format('YYYY-MM-DD HH:mm:ss');
                const status = 'Mesin';
                
                await new Promise((resolve) => {
                    db.run('INSERT INTO absensi (nama, waktu, status) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM absensi WHERE nama=? AND waktu=?)', 
                        [nama, waktu, status, nama, waktu], resolve);
                });
            }
        }
        
        await zkInstance.disconnect();
        res.json({ success: true, message: 'Sinkronisasi berhasil!' });
    } catch (e) {
        res.json({ success: false, message: e.message || 'Gagal koneksi ke mesin absensi.' });
    }
});

// Cek Status Mesin
app.get('/api/machine-status', async (req, res) => {
    const ip = req.query.ip || '192.168.1.201';
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