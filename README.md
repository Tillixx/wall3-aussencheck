# Wall3 Außencheck

Prüft die Wall3-Seiten **von außen** (GitHub-Rechner): Erreichbarkeit, Zertifikate,
Mailserver, Durchklick mit echtem Browser, nachts Ablauf-Tests ohne Anmeldung.
Schlägt ein Lauf fehl, meldet GitHub das per Mail an den Besitzer.

Öffentlich, weil öffentliche Repos unbegrenzt freie Actions-Minuten haben.
Server-Adresse, Portlisten und Meldeadresse liegen nur als Repository-Secrets vor.
