# À Deux — carte du projet

À lire avant toute modification : ce fichier suffit pour savoir où intervenir sans relire tout le code.

## En bref

PWA pour iPhone (ajoutée à l'écran d'accueil depuis Safari). Elle propose des recettes économiques,
le même plat pour tout le foyer avec des portions calculées par personne selon son objectif de poids,
gère un placard, une liste de courses, un menu de plusieurs repas et un suivi du poids.

- Aucune dépendance, aucun build : HTML + CSS + modules ES natifs.
- Hébergement : GitHub Pages, dépôt public `nightmife/a-deux`, branche `main`, racine.
  URL : https://nightmife.github.io/a-deux/
- Données : `localStorage` sur chaque appareil, plus synchro optionnelle via Supabase.
- Magasin : Intermarché uniquement, prix estimés à la main (pas de prix en direct).

## Commandes

```sh
npm test      # node --test tests/  (logique + synchro, sans navigateur)
npm start     # python3 -m http.server 8080
git push origin main   # déploie (GitHub Pages reconstruit en 1 min environ)
```

Après chaque modification de fichier servi : incrémenter `CACHE` dans `sw.js` (`adeux-vN`),
sinon les iPhones gardent l'ancienne version plus longtemps.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Coquille : `#view` (écran), `#tabs` (barre d'onglets), `#sheet` (modale), `#toast` |
| `css/app.css` | Tout le style. Jetons de couleur dans `:root`, thème sombre via `prefers-color-scheme` |
| `js/data.js` | Données : `INGREDIENTS`, `RECIPES`, `CATS` (rayons), `EQUIPMENT`, `AVOID`, `BOOST_CAP` |
| `js/logic.js` | Logique pure, sans DOM : calories, portions, courses, placard, suggestions, formatage |
| `js/app.js` | Interface : état, rendu, actions, onboarding, feuilles modales |
| `js/sync.js` | Moteur de synchro (indépendant du DOM et du réseau, `rpc` et `store` injectés) |
| `js/merge.js` | Fusion à trois voies d'états JSON (`merge3`, `eq`) |
| `js/config.js` | URL et clé publique Supabase. Vide = synchro désactivée, l'app retombe sur l'export par code |
| `js/photos.js` | Généré : `PHOTOS[id] = {a: auteur, l: licence, u: page source}` |
| `img/recipes/<id>.jpg` | Photos 900×675 (Wikimedia Commons) |
| `sw.js` | Service worker : réseau d'abord pour le code, cache d'abord pour les images |
| `supabase/schema.sql` | Table `households` + fonctions `household_get` / `household_put` |
| `tools/photos.py` | Recherche et téléchargement des photos, `tools/photo_choices.json` = choix retenus |
| `tests/*.test.mjs` | Tests `node:test` de `logic.js`, `merge.js`, `sync.js` |

## Données (`js/data.js`)

**Ingrédient** : `I(nom, unité, paquet, libelléPaquet, prix, rayon, kcal, prot, rôle, extras)`

- `u` : `g`, `ml` ou `pc` (pièce). `k`/`p` = kcal et protéines pour 100 g/ml, ou **par pièce** si `pc`.
- `pack` : quantité vendue (dans l'unité), `pl` : libellé affiché, `pr` : prix du paquet en euros.
- `role` : `p` protéine, `c` féculent, `v` légume, `f` gras/fromage, `o` autre.
- Extras : `kind` (porc, boeuf, volaille, poisson : sert aux exclusions), `sp` (grammes par cuillère à café,
  déclenche l'affichage « c. à s. »), `un` (nom de l'unité : tranche, gousse…), `step` (arrondi des pièces),
  `staple` (proposé dans « déjà dans vos placards » à l'onboarding).

**Recette** : `R(id, nom, emoji, minutes, équipement, ingrédients, étapes, boost, extras)`

- Quantités pour **une portion standard d'environ 600 kcal**. Elles sont mises à l'échelle par personne.
- `équipement` : `'pl af|fo'` signifie plaques ET (air fryer OU four). Codes : `pl af fo mo mx`.
- `ingrédients` : `'poulet:130, riz:70, painburger:1:o'` (`id:quantité[:rôle forcé]`).
- Les étapes ne contiennent **aucune quantité** (elles changent selon les personnes).
- `boost` : ingrédient dense ajouté dans l'assiette de qui veut prendre du poids (clé de `BOOST_CAP`).
- `extras.whole` : plat assemblé (croque, wrap…), toutes les proportions sont conservées.
- `extras.unit` : `['croque', 'painmie', 2]` affiche « 4 croques » (2 tranches par croque).

Un test vérifie que chaque recette atteint la cible calorique à ±8 % et au moins 25 g de protéines
pour le profil « perte de poids », et qu'aucun ingrédient n'est inutilisé.

## Logique (`js/logic.js`)

- `targets(p)` : Mifflin-St Jeor × activité. Perte : −20 % (plancher 1500/1200 kcal). Prise : +350 kcal.
  Un repas vise `MEAL_SHARE` = 35 % des calories du jour.
- `portion(recette, personne)` : multiplicateurs par rôle selon le mode (perte : plus de protéines et de
  légumes, moins de gras ; prise : l'inverse), l'appétit ne joue que sur les légumes. Les féculents
  comblent l'écart (facteur borné 0,5 à 1,7), puis mise à l'échelle uniforme, puis boost pour la prise de poids.
  Si `whole`, seule la mise à l'échelle uniforme s'applique.
- `needs(recette, personnes)` : total à cuisiner, arrondi (`roundQty`), aligné sur un paquet entier si le
  dépassement est inférieur à 12 %.
- `shopping(menu, personnes, stock)` : besoins du menu moins le placard, convertis en paquets, triés par rayon.
- `leftovers(...)` : ce qui restera après achat et cuisson du menu. Sert à favoriser les recettes qui réutilisent les restes.
- `cook(stock, recette, personnes)` : retire les quantités ; un ingrédient sous 2 % d'un paquet disparaît.
- `rankRecipes(state, rng)` : score = coût à acheter + coût réel − bonus restes + pénalité « cuisinée récemment »
  + pénalité « même protéine déjà au menu » + aléa. Filtre matériel, exclusions, recettes masquées.
- `planMenu(state, n)` : complète le menu jusqu'à n repas, plats frais en premier.
- `fmtQty` (recette) et `fmtStock` (placard) : affichage des quantités.

## État (`js/app.js`)

Un seul objet `S`, enregistré dans `localStorage['adeux.v1']` :

```js
{ v: 1, onboarded, people: [{ id, name, sex, age, height, weight, goal, activity, appetite, weighIns: [{d, w}] }],
  equip: ['pl','af'], avoid: [], stock: { ingId: quantité }, menu: [recetteId], checked: { ingId: true },
  history: [{ id, d, t }], disliked: [], skipped: [], current: recetteId }
```

- `sanitize()` nettoie tout état chargé ou reçu ; `weight` vaut toujours la dernière pesée.
- Toute modification passe par `save()` (ou `commit()` = save + render), qui déclenche aussi la synchro.
- `ui` contient l'état d'écran non persistant (onglet, feuille ouverte, brouillon de formulaire).

## Interface (`js/app.js`)

- Rendu par chaînes de gabarit : `render()` réécrit `#view` selon `ui.tab` (`VIEWS`), `renderSheet()` réécrit
  la modale selon `ui.sheet.type` (`SHEETS`). Le défilement est conservé.
- Événements : un seul écouteur de clic. Un élément `data-a="nom"` appelle `A['nom'](dataset, element)`.
  Les formulaires utilisent `data-a-submit="nom"`.
- Champs de formulaire : `data-f="champ"` écrit dans `ui.draft` à chaque frappe.
- Toute donnée utilisateur affichée passe par `esc()`.
- Ajouter un écran : une fonction `viewXxx`, une entrée dans `VIEWS` et `TABS`. Ajouter une modale : `sheetXxx` + `SHEETS`.

## Synchronisation

- Supabase, table `households(code, data jsonb, rev)`, sans policy : accès uniquement par deux fonctions
  `security definer` qui exigent le **code du foyer** (10 caractères, sert de mot de passe).
- `household_put(code, data, rev)` : `rev = 0` crée ; sinon écrit seulement si la révision n'a pas bougé,
  et renvoie l'état serveur en cas de conflit.
- Côté app : `sync.push()` après chaque `save()` (anti-rebond 300 ms), `sync.pull()` toutes les 4 s quand
  l'app est visible. Conflit ou changement distant : `merge3(base, local, distant)` puis `applyRemote()`.
- Règles de fusion : listes fusionnées par identité (id, `t`, `d` ou valeur), stock additionné par variations,
  même champ modifié des deux côtés : le serveur l'emporte.
- Métadonnées locales dans `localStorage['adeux.sync']` : `{ code, rev, base }`.
- La clé dans `config.js` est la clé **publique** (publishable). Ne jamais y mettre la clé `service_role`.

## Recettes de modification courantes

- **Ajouter une recette** : une ligne `R(...)` dans `data.js`, `npm test`, puis une photo (ci-dessous).
- **Ajouter un ingrédient** : une ligne `I(...)` ; il doit être utilisé par au moins une recette (test).
- **Changer un prix** : champ `pr` de l'ingrédient.
- **Ajouter une photo** : requête dans `QUERIES` de `tools/photos.py`, puis
  `python3 tools/photos.py candidates <cache>` (planches contact à regarder), choix dans
  `tools/photo_choices.json` (`{"i": index}` ou `{"q": "autre requête"}`), puis `python3 tools/photos.py build <cache>`.
  Wikimedia limite le débit : le script attend et reprend tout seul.
- **Ajouter un magasin** : non prévu. Il faudrait un prix et une disponibilité par enseigne dans chaque ingrédient.

## Pièges connus

- Un `<button>` sans attribut `type` vaut `submit` : le gestionnaire de clic teste `getAttribute('type')`, pas `el.type`.
- `chain.then(fn)` passerait le résultat précédent en argument : dans `sync.js` on écrit `chain.then(() => fn())`.
- Sur iOS, Safari et l'app installée ont des stockages séparés : toujours importer ou rejoindre depuis l'app installée.
- Tests d'interface : aucun navigateur n'est installé sur la machine. Utiliser Playwright Chromium dans un dossier
  temporaire, profil `devices['iPhone 14']`. Intercepter `**/js/config.js` pour désactiver ou simuler Supabase,
  afin de ne pas créer de foyers de test dans le vrai projet. Pas de police emoji : carrés normaux dans les captures.
- `pkill -f "http.server 8766"` tue aussi le shell qui le lance : écrire `"http.server 876[6]"`.
- Une ligne de test `TESTSYNC00` existe dans la table Supabase, sans conséquence.
