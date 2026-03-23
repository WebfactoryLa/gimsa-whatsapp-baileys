#!/bin/bash
# ═══════════════════════════════════════════════════
# GIMSA WhatsApp Baileys — Actualización a Multi-Número
# Correr estos comandos desde ~/Downloads/baileys-service
# ═══════════════════════════════════════════════════

cd ~/Downloads/baileys-service

# 1. Reemplazar archivos existentes con las nuevas versiones
# (copiá los archivos del .tar que descargaste, o pegá manualmente)

# 2. Commit y push
git add -A
git commit -m "v2.0: Multi-número con instancias independientes por línea"
git push
