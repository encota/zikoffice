#!/bin/sh
# Dopo l'installazione: aggiorna l'elenco delle app e rende ZikOffice l'app predefinita
# per i formati che apre, per l'utente che sta installando (sudo apt / pkexec).
# Se non si sa chi è (installazione da un programma grafico) lo fa ZikOffice al primo avvio.
set -e
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi
U="${SUDO_USER:-}"
if [ -z "$U" ] && [ -n "${PKEXEC_UID:-}" ]; then
  U=$(getent passwd "$PKEXEC_UID" | cut -d: -f1)
fi
if [ -n "$U" ] && [ "$U" != "root" ] && command -v runuser >/dev/null 2>&1; then
  H=$(getent passwd "$U" | cut -d: -f6)
  runuser -u "$U" -- env HOME="$H" XDG_CONFIG_HOME="$H/.config" /usr/bin/zik --register-file-types || true
fi
exit 0
