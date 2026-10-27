# Character Library

[English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [繁體中文](README.zh-TW.md) · [Русский](README.ru.md) · **Français** · [简体中文](README.md)

> Une galerie locale de matériel anime / cosplay qui tourne entièrement sur votre machine.
> Les images et vidéos sont rangées sur quatre niveaux — **bibliothèque → fiche → pack → images | vidéos** —
> et l'arborescence sur le disque reprend exactement celle de l'interface. Grille masonry, étiquettes,
> lecteur de bandes dessinées, extraction automatique des archives et synchronisation incrémentale du disque
> sont inclus. **Rien ne quitte votre machine : pas de cloud, pas d'envoi, pas de télémétrie.**

**Ce n'est pas un scanner.** Les fichiers sont **copiés** dans la bibliothèque, puis classés et modifiés
librement ; le dossier d'origine n'est jamais touché.

> L'interface et les commentaires du code sont **uniquement en chinois simplifié** (l'application n'est pas
> traduite). **Ce fichier est un résumé.** Le manuel complet (chaque écran, la table des API, les réglages de
> performance, les limites connues, l'historique des versions) n'existe qu'en deux versions :
> **[简体中文](README.md)** et **[English](README.en.md)**.

## Aperçu

**Liste de la bibliothèque** — une carte par fiche, le badge indique le nombre de packs.
En haut, le changement de bibliothèque et une recherche globale.

![Liste de la bibliothèque](docs/screenshots/shelf-grid.jpg)

**Détail d'une fiche** — la couverture et les compteurs à gauche, la source et les alias au centre,
les packs en dessous. Basculez sur « tous les médias » pour voir tous les fichiers de la fiche.

![Détail d'une fiche](docs/screenshots/character-detail.jpg)

## Fonctionnalités

- **Cinq types de bibliothèques** — personnes (cosplayeur + comptes), personnages (regroupés par œuvre),
  ressources (une carte par œuvre), emojis / images en vrac (à plat), romans (liseuse TXT intégrée +
  illustrations + pochettes de BD). Plus une bibliothèque « fourre-tout » qui récolte les fichiers
  non classés avant répartition.
- **Quatre façons d'alimenter**
  - Glisser-déposer : jusqu'à 400 fichiers d'un coup, 4 Go par fichier, avec progression et raison d'échec
  - **Déposez une archive** : zip / rar / 7z / tar.gz est extrait automatiquement, seules les images et les
    vidéos sont gardées. Le zip est décodé en interne (les noms de fichiers GBK ne cassent pas),
    **les archives chiffrées demandent un mot de passe et le mémorisent**
  - Import massif depuis un dossier : déduplication par sha256, création des packs d'après la date du nom de
    fichier, `--move` ne supprime la source qu'après vérification de la copie dans la bibliothèque
  - **Glisser-déposer dans la coque de bureau** : le navigateur ne reçoit que des octets, la coque connaît le
    chemin réel — le fichier source peut donc être **supprimé dès l'import terminé**
- **Consultation** — grille masonry dessinée par lots (des dizaines de milliers de vignettes sans saccade),
  quatre critères de tri, images larges sur deux colonnes, vignettes générées à l'import
- **Étiquettes** — un nom de pack du type « personnage-tenue » est découpé en deux étiquettes, le nom de la
  fiche en devient une aussi, un clic ouvre la page d'étiquette
- **Recherche** — la barre du haut couvre la liste des bibliothèques, les fiches, la bibliothèque de ressources
  et le détail d'une ressource ; le serveur cherche aussi dans les étiquettes (taper un nom d'œuvre remonte les
  fiches qui ne le portent que comme étiquette)
- **Lecteur de BD** — défilement continu / page simple / double page, sens droite à gauche, ajustement en
  hauteur ou en largeur, plein écran, molette pour tourner, rail latéral qui se réduit en fenêtre étroite
- **Sélection et clavier** — Shift pour une plage, Ctrl pour ajouter ou retirer, `Ctrl+A` tout sélectionner,
  Delete, Échap ; menu contextuel sur presque chaque élément
- **Synchronisation du disque** — chaque renommage, déplacement ou suppression écrit une entrée de journal
  **dans la même transaction** que la modification des données. Le bouton de synchronisation ne rejoue que ces
  entrées, ne scanne jamais toute la bibliothèque, et ne supprime jamais un fichier qu'il n'a pas placé
- **Sauvegarde** — `VACUUM INTO` + vérification par échantillonnage de hachages + MANIFEST, 5 copies conservées

## Technique

| Partie | |
|---|---|
| Frontend | Modules ES natifs, **aucune étape de build** (ni webpack, ni vite, ni bundler), variables CSS et composants écrits à la main |
| Backend | Node 22 · Express 5 · better-sqlite3 · sharp (libvips) · ffmpeg |
| Coque de bureau | Rust · tao + wry (WebView2) — **un seul exe de 689 Ko**, CRT lié statiquement, aucune DLL à fournir |
| Stockage | Index SQLite + originaux sur le disque ; les chemins sont stockés **en relatif** par rapport à la racine des données, donc la bibliothèque peut changer de disque sans migration |

## Démarrage rapide

Nécessite **Node.js 20+** (développé et testé sur 22). La base est créée au premier lancement.

```bash
cd server && npm install && cd ..
start.bat          # démarre le serveur et ouvre http://127.0.0.1:7788
```

Le dossier de données par défaut est `E:\CharacterLibrary`. Pour le changer :

```bat
set CL_DATA_DIR=D:\MyLibrary
set CL_CACHE_DIR=D:\my-cache
start.bat
```

Pour une fenêtre au lieu d'un onglet, compilez la coque de bureau (Rust et VS2022 Build Tools requis) :

```bash
node desktop/build.mjs      # produit 资料库.exe à la racine du projet
```

L'exe doit rester à la racine du projet : il cherche `server/src/index.js` en remontant l'arborescence.
Pour le bureau, créez un raccourci.

## Où vivent les données

| Élément | Par défaut | Contenu |
|---|---|---|
| Programme | dossier du dépôt | code, `web/`, `server/`, l'exe, `.cache` (vignettes, supprimables) |
| Données | `E:\CharacterLibrary` (`CL_DATA_DIR`) | médias d'origine + index `.catalog\library.db` |
| Sauvegardes | `E:\CharacterLibrary-Backup` (`CL_BACKUP_DIR`) | un dossier horodaté par exécution, 5 conservés |

Mettez les données sur un disque mécanique (volume, lecture séquentielle) et le cache sur un SSD
(beaucoup de lectures aléatoires).

## Limites connues

- 4 Go par fichier, 400 fichiers par envoi (archives comprises)
- L'extraction rar / 7z nécessite 7-Zip ou WinRAR (le `tar.exe` fourni avec Windows convient aussi) ; zip ne
  demande rien
- `mkv` / `avi` peuvent ne pas être lus dans le navigateur
- Déplacer des médias entre packs d'une même fiche ne met à jour que la base ; les fichiers bougent à la
  synchronisation suivante
- La coque de bureau est réservée à Windows (WebView2) ; l'application web elle-même tourne partout où Node tourne
- **L'interface est uniquement en chinois.** Il n'y a pas de couche i18n et aucune n'est prévue.

## Licence

Projet personnel, **aucune licence open source déclarée** (All rights reserved). Le code est public pour
permettre de lire l'implémentation et d'ouvrir des issues ; cela n'autorise ni l'usage commercial ni la
redistribution.
