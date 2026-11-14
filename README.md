# À Deux

PWA (installable sur iPhone) qui propose des recettes économiques adaptées aux objectifs de poids de chacun :
même plat pour tout le foyer, portions calculées par personne, liste de courses qui tient compte du placard,
recettes filtrées selon le matériel de cuisine, suivi du poids.

Aucune dépendance, aucun build : HTML/CSS/JS natifs, données stockées sur l'appareil.

## Lancer en local

```sh
npm start          # sert le dossier sur http://localhost:8080
npm test           # tests de la logique (node --test)
```

## Installer sur iPhone

Ouvrir l'URL du site dans Safari → bouton Partager → « Sur l'écran d'accueil ».

## Structure

- `js/data.js` : ingrédients (prix estimés Intermarché) et recettes
- `js/logic.js` : calories, portions, placard, courses, suggestions (pur, testé)
- `js/app.js` : interface
- `tools/photos.py` : récupération des photos (Wikimedia Commons) et de leurs crédits
