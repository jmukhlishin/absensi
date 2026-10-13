const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const moment = require('moment');

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
        db.run(`CREATE TABLE IF NOT EXISTS absensi (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nama TEXT NOT NULL,
            waktu TEXT NOT NULL,
            status TEXT NOT NULL
        )`);
    }
});

// Routes
app.get('/', (req, res) => {
    db.all('SELECT * FROM absensi ORDER BY waktu DESC', [], (err, rows) => {
        if (err) {
            throw err;
        }
        res.render('index', { data: rows });
    });
});

app.post('/absen', (req, res) => {
    const { nama, status } = req.body;
    const waktu = moment().format('YYYY-MM-DD HH:mm:ss');
    
    db.run(`INSERT INTO absensi (nama, waktu, status) VALUES (?, ?, ?)`, [nama, waktu, status], function(err) {
        if (err) {
            return console.log(err.message);
        }
        res.redirect('/');
    });
});

app.listen(port, () => {
    console.log(`Server berjalan di http://localhost:${port}`);
    console.log(`Siap dijalankan berdampingan dengan n8n (pastikan port tidak bentrok)`);
});