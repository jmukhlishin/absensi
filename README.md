## Project Files Structure 

- server.js: Backend Express sekaligus inisialisasi tabel absensi otomatis.
- views/index.ejs: Halaman antarmuka dashboard untuk melihat log dan riwayat absensi.
- README.md: Panduan instalasi dan deployment di Ubuntu Server menggunakan PM2.

# Sistem Absensi Node.js

Sistem absensi berbasis Node.js (Express), SQLite, dan EJS yang dirancang ringan dan siap berjalan di server lokal Ubuntu berdampingan dengan **n8n**.

## 🚀 Fitur
- Form absensi (Nama, Status: Hadir/Izin/Sakit).
- Tabel untuk melihat riwayat absensi.
- Database lokal menggunakan SQLite (file `absensi.db` akan dibuat secara otomatis).
- Siap berjalan berdampingan dengan n8n tanpa konfigurasi tambahan khusus (Selama port default tidak bentrok).

## 🛠️ Persyaratan
- **Node.js** (Minimal versi 14.x)
- **npm** (Node Package Manager)

## 📦 Instalasi di Ubuntu Server

1. **Clone repositori ini:**
   ```bash
   git clone https://github.com/jmukhlishin/absensi.git
   cd absensi
   ```

2. **Install dependensi:**
   ```bash
   npm install
   ```

3. **Jalankan Aplikasi:**
   ```bash
   npm start
   ```

Aplikasi akan berjalan di `http://localhost:3000`.

## 🔄 Menjalankan Berdampingan dengan n8n

- **Port Management**: Secara default, `n8n` berjalan di port `5678`, dan aplikasi absensi ini berjalan di port `3000`. Pastikan port `3000` tidak sedang digunakan oleh layanan web lain di Ubuntu Anda.
- **Webhook Integration**: Anda dapat dengan mudah mengintegrasikan sistem ini dengan n8n. Misalnya, mengirim webhook notifikasi WhatsApp/Telegram setiap ada data absensi baru. Anda cukup memodifikasi `server.js` untuk melakukan HTTP POST ke URL webhook n8n Anda saat endpoint `/absen` dipanggil.
- **Process Manager (PM2)**: Sangat direkomendasikan menjalankan n8n dan sistem Node.js ini menggunakan `pm2` agar terus berjalan di background (daemon) bahkan jika terminal ditutup.
  
  ```bash
  npm install -g pm2
  
  # Menjalankan n8n
  pm2 start n8n
  
  # Menjalankan sistem absensi
  pm2 start server.js --name "absensi-app"
  
  # Menyimpan konfigurasi agar berjalan saat booting
  pm2 save
  pm2 startup
  ```
