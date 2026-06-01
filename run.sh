#!/data/data/com.termux/files/usr/bin/bash
set -e

echo "=== Musicali Bar — Setup para Termux ==="
echo ""

# Actualizar paquetes
echo "[1/4] Actualizando repositorios..."
pkg update -y && pkg upgrade -y

# Instalar dependencias
echo "[2/4] Instalando Node.js y yt-dlp..."
pkg install -y nodejs yt-dlp

# Instalar dependencias npm
echo "[3/4] Instalando dependencias npm..."
cd "$(dirname "$0")"
npm install @microsoft/signalr

# Arrancar server
echo "[4/4] Iniciando servidor..."
node server.js &

echo ""
echo "✅ Servidor corriendo en background"
echo "   Abrí http://localhost:3000 en el navegador"
