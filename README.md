# WatchParty 🎬

Regardez un film/série en groupe : lecteur synchronisé + appel vidéo + chat, dans une seule page.

## Installation locale

```bash
npm install
npm start
```

Puis ouvre http://localhost:3000

## Comment ça marche

1. Une personne clique sur **"Créer une room"** → elle obtient un code de room et un lien à partager.
2. Les autres rejoignent avec ce lien (ou en tapant le code sur la page d'accueil).
3. N'importe qui dans la room peut cliquer sur **"📁 Choisir une vidéo"** pour uploader le fichier vidéo — il est envoyé au serveur et tout le monde le regarde en streaming depuis là, synchronisé (play/pause/avance rapide se répercutent chez tout le monde).
4. La caméra/micro s'activent automatiquement (demande d'autorisation navigateur) et les flux vidéo des autres apparaissent en vignettes.
5. Le chat est à droite, en dessous des vignettes.

## Déployer en ligne (pour que ta copine/le groupe puisse rejoindre à distance)

Le plus simple : **Render.com** ou **Railway.app** (gratuit pour un usage perso) :

1. Mets ce dossier sur un repo GitHub.
2. Sur Render : "New Web Service" → connecte le repo → Build command `npm install` → Start command `npm start`.
3. Une fois déployé, partage l'URL générée (ex: `https://tonapp.onrender.com`) à la place de `localhost:3000`.

Alternative : un petit VPS (OVH, Hetzner...) avec Node.js installé + `pm2` pour garder le process actif, et un nom de domaine pointé dessus.

## Limites à connaître

- **Taille vidéo** : la limite est fixée à 5 Go dans `server.js` (`multer` `limits.fileSize`). Ajuste selon ton hébergement (attention aux espaces disques limités sur les plans gratuits).
- **Appel vidéo en mesh** : chaque participant se connecte directement à tous les autres (peer-to-peer). Ça fonctionne très bien jusqu'à 5-6 personnes ; au-delà, la bande passante de chacun devient le goulot d'étranglement (chaque personne upload sa vidéo N fois, une par participant). Pour un vrai usage "grand groupe" (8+), il faudrait passer à un serveur SFU (ex: mediasoup, LiveKit) — dis-moi si tu veux que je pousse dans cette direction plus tard.
- **HTTPS obligatoire en production** : les navigateurs n'autorisent la caméra/micro (`getUserMedia`) que sur `https://` ou `localhost`. Les hébergeurs cités (Render/Railway) fournissent HTTPS automatiquement.
- **Stockage vidéo** : les fichiers uploadés restent sur le serveur dans `public/uploads/`. Pense à les nettoyer périodiquement si tu héberges plusieurs films dans le temps.
- Pas de compte/auth : n'importe qui avec le lien peut rejoindre la room. Suffisant pour un usage privé entre proches, mais garde les liens seulement pour les gens à qui tu les envoies.

## Structure du projet

```
watchparty/
├── server.js          # serveur Express + Socket.io (rooms, sync, chat, signalisation WebRTC)
├── package.json
└── public/
    ├── index.html      # page d'accueil (créer/rejoindre)
    ├── room.html        # page principale (lecteur, appel, chat)
    ├── style.css
    ├── app.js           # logique client (sync vidéo, WebRTC mesh, chat)
    └── uploads/         # vidéos uploadées (créé automatiquement)
```
