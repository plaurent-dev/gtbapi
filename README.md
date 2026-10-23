# GTB API (Modbus TCP -> HTTP)

API Node.js pour lire un compteur via le convertisseur Waveshare RS485-to-POE-Eth(B) et exposer les mesures en REST.

## 1) Installation

```bash
npm install
```

## 2) Configuration

```bash
copy .env.example .env
```

Variables importantes:
- `MODBUS_HOST`: IP de la passerelle Waveshare (si connue)
- `MODBUS_PORT`: port Modbus TCP (par defaut `4196`)
- `MODBUS_UNIT_ID`: ID esclave (`91` dans ton script Python)
- `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` : connexion PostgreSQL
  pour l'inventaire partage de cordongtb et, si activee, l'insertion de mesures.
  Sans `PGUSER`, les profils et lectures Modbus restent disponibles, mais les
  listes `gateways` sont explicitement indisponibles.
- `MEASUREMENTS_API_KEY` : cle Bearer obligatoire pour l'insertion HTTP de
  mesures (au moins 32 caracteres). Vide par defaut : insertion desactivee.

## 3) Demarrage local

```bash
npm run dev
```

## 4) Retrouver l'IP du dispositif

Scanner rapide du reseau (`192.168.1.x` par defaut):

```bash
curl "http://localhost:3000/api/v1/meter/discover"
```

Exemple personnalise:

```bash
curl "http://localhost:3000/api/v1/meter/discover?subnet=192.168.1&from=1&to=254&port=4196&verifyModbus=true"
```

Le resultat renvoie les hotes joignables et, si verification activee, le `serial_number` lu en Modbus.

## 5) Lire les mesures

```bash
curl "http://localhost:3000/api/v1/meter/read?host=192.168.1.50"
```

## 5b) Trouver les Unit ID sur une IP cible

Scanner les adresses esclaves Modbus (1 a 247 par defaut) pour une IP donnee:

```bash
curl "http://localhost:3000/api/v1/meter/discover-unitid?host=192.168.1.20"
```

Limiter la plage et ajuster le timeout:

```bash
curl "http://localhost:3000/api/v1/meter/discover-unitid?host=192.168.1.20&fromUnitId=1&toUnitId=30&timeoutMs=400&probe=both"
```

## 5c) Lire un registre brut avec host + unitId

Pratique pour valider rapidement un compteur (ex: Eastron, unitId=1) sans mapping metier:

```bash
curl "http://localhost:3000/api/v1/meter/read-raw?host=192.168.1.20&unitId=1&type=input&address=0&count=2"
```

Exemple holding register:

```bash
curl "http://localhost:3000/api/v1/meter/read-raw?host=192.168.1.19&unitId=91&type=holding&address=0&count=1"
```

## 5d) Lire via un profil de device (valeurs traduites)

Lister les profils disponibles:

```bash
curl "http://localhost:3000/api/v1/meter/profiles"
```

Chaque profil conserve ses definitions et ajoute `gateways`, avec **une entree
par capteur enregistre** dans `public.gtb_sensors`. Exemple de ce champ pour
`eastron-sdm120ct` :

```json
{
  "gateways": [
    { "host": "10.107.31.4", "port": 4196, "unitId": 10 },
    { "host": "10.107.31.4", "port": 4196, "unitId": 20 },
    { "host": "10.107.31.5", "port": 502, "unitId": 1 }
  ]
}
```

Une meme passerelle peut donc apparaitre plusieurs fois avec des Unit ID
differents. Les profils sans capteur enregistre ont `gateways: []`. Les listes
sont triees par IP, port et Unit ID et relues en base a chaque requete : une
reaffectation, suppression ou modification d'Unit ID enregistree dans cordongtb
est visible au prochain appel. `count` reste le nombre de profils, pas de capteurs.
Il ne s'agit pas d'un scan reseau ni d'une preuve de presence des equipements.
Les objets uniquement declares sur le plan, sans entree dans l'inventaire, ne
sont pas inclus. Seuls les profils connus de cette version de GTBApi sont listes.

Au niveau racine, `gatewaysAvailable: true` et `gatewaysWarning: null` confirment
que l'inventaire a ete lu. Sans configuration, en cas d'erreur de connexion, de
schema ou de droits, la reponse HTTP reste **200** avec toutes les definitions,
mais chaque profil porte **`gateways: null`** et la racine contient
`gatewaysAvailable: false` ainsi qu'un message explicite dans `gatewaysWarning`.
Ne pas interpreter `null` comme une liste vide. Les lectures Modbus ne dependent
pas de PostgreSQL. Plus de 1000 capteurs correspondants provoquent aussi ce mode
degrade, sans liste partielle. Les details internes des erreurs ne sont pas exposes.

Configurer le fichier `.env` **du service GTBApi**, independamment de celui de
cordongtb, avec la meme base d'inventaire :

```dotenv
PGHOST=10.62.20.49
PGPORT=5432
PGDATABASE=gtb_db
PGUSER=gtb_api_user
PGPASSWORD=
```

Renseigner le mot de passe hors du depot, puis redemarrer GTBApi. Aucun schema
ni migration supplementaire n'est cree ; la table de la migration 009 de
cordongtb doit deja exister. Le compte PostgreSQL peut etre un role dedie en
lecture seule ; seuls CONNECT a la base, USAGE sur le schema et SELECT sur
`public.gtb_sensors` sont necessaires. Les requetes du pool sont en lecture
seule, avec delais limites et fermeture du pool a l'arret du service.
Ne pas exposer publiquement cet endpoint interne, qui contient les adresses des
equipements enregistres.

Lire un Eastron SDM120CT avec decoding metier:

```bash
curl "http://localhost:3000/api/v1/meter/read-profile?host=192.168.1.20&profile=eastron-sdm120ct&unitId=1"
```

Lire un POLIER MM80LMZMOD:

```bash
curl "http://localhost:3000/api/v1/meter/read-profile?host=192.168.1.19&profile=polier-mm80lmzmod&unitId=91"
```

Lire un débitmètre TUF-2000M:

```bash
curl "http://localhost:3000/api/v1/meter/read-profile?host=192.168.1.20&profile=tuf-2000m&unitId=1"
```

Le profil utilise les registres Holding (fonction Modbus 03). Les numéros de registre du manuel sont convertis en adresses Modbus commençant à zéro. La liaison série RTU du TUF est à configurer par défaut en `9600, 8N1` (parité None), avec le même débit, la même parité et le même nombre de bits d'arrêt sur la passerelle RS485. Le profil suppose l'adresse esclave `1`; remplacer `unitId` par l'adresse réelle si nécessaire. Les valeurs REAL4 et les adresses devront être vérifiées par lecture brute lors de la mise en service.

### Capteur d'ambiance TS85-B : temperature, humidite et CO2

```bash
curl "http://localhost:3000/api/v1/meter/read-profile?host=192.168.1.20&port=4196&profile=ts85-b&unitId=1"
```

Profil `ts85-b`, selon le manuel **TS85-B**, sections 3, 6 et 8 :

| Valeur JSON | Adresse Holding (zero-based) | Format | Unite |
|---|---|---|---|
| `temperature_c` | `0x0000` | entier signe 16 bits, complement a deux, divise par 10 | degres Celsius |
| `humidity_percent` | `0x0001` | entier non signe 16 bits, divise par 10 | % RH |
| `co2_ppm` | `0x0002` | entier non signe 16 bits | ppm |

Les trois valeurs sont lues par FC03, un registre chacune, octet fort en premier.
Exemple du manuel : `0x0111`, `0x0237`, `0x01A7` donnent `27.3`, `56.7`, `423`.
La temperature `0xFF9B` donne `-10.1`, pas une valeur positive.
Reglages usine : adresse esclave `1`, liaison serie **9600 bauds, 8N1**.
La passerelle RS485/Ethernet doit utiliser les memes reglages serie.
Le port TCP est celui de la passerelle, pas un reglage du profil.

Le profil est en lecture seule et n'active pas **Changer ID**. Aucune commande
FC06 de configuration ou de broadcast du manuel n'est envoyee.
Apres deploiement de GTBApi, le profil apparait automatiquement dans la liste des
profils de cordongtb ; deployer aussi cordongtb pour les libelles et unites.
La lecture ne cree pas de collecte historique automatique.

## 5e) Adresse Eastron SDM120CT : lecture et changement

Le profil `eastron-sdm120ct` expose `device_address`, lu par FC03 dans le
registre Holding 40021 (adresse zero-based `0x0014`, deux mots float32 BE).
La liste des profils expose `canChangeUnitId: true` uniquement pour ce profil.

`POST /api/v1/meter/change-unitid` accepte ce corps JSON :

```json
{
  "host": "10.107.31.4",
  "port": 4196,
  "profile": "eastron-sdm120ct",
  "unitId": 1,
  "newUnitId": 7,
  "setupConfirmed": true
}
```

Les deux adresses doivent etre distinctes et comprises entre 1 et 247.
Le manuel SDM120-Modbus fourni demande un appui de 3 secondes pour entrer en
mode SET avant programmation par RS485. FC10 dans le tableau est hexadecimal :
`0x10` = FC16, ecriture de plusieurs registres ; ce n'est pas une commande
d'activation du mode SET.

Suspendre les collecteurs et autres interrogations du bus avant l'operation.
S'assurer qu'un seul compteur utilise l'ancienne adresse, et que la nouvelle est
libre. L'API relit l'ancienne adresse, sonde la nouvelle par FC03 et FC04,
refuse une reponse ou exception Modbus, puis ecrit le float32 par FC16 et relit
40021 a la nouvelle adresse. Une absence de reponse ne garantit pas qu'un
equipement eteint ou non joignable n'utilise pas deja cette adresse.
Un seul changement est autorise a la fois par passerelle dans ce processus.

La reponse contient `previousUnitId`, `unitId` et `verified: true` uniquement
apres verification. Aucun nouvel essai d'ecriture automatique n'est effectue.
En cas d'echec apres tentative d'ecriture, l'adresse peut avoir change :
rechercher les deux adresses avant de recommencer. L'API ne modifie aucun
inventaire ni configuration de collecteur.

Cette API interne ne doit pas etre exposee directement a Internet. La console
Cordon GTB fournit le point d'entree authentifie et limite au sous-reseau GTB.

Reference : [manuel SDM120-Modbus, pages 7 et 10-11](https://xn--stromzhler-v5a.eu/media/7e/64/b6/1696582669/sdm120modbus_manual.pdf).
La compatibilite doit etre confirmee a la mise en service sur le modele et
firmware reels ; ne pas utiliser cette operation pour un autre profil.

Validation sans materiel : `node --test test\modbus-unitid.test.js`.

## 5f) Inserer les mesures depuis n8n

`POST /api/v1/meter/measurements` insere **une ligne par appel** dans la table
existante `public.mesures_rs485`. Il remplace le noeud PostgreSQL d'insertion,
pas les lectures Modbus. Aucune table ni migration n'est creee automatiquement.
La route ne lit pas le capteur et ne modifie ni son Unit ID ni son inventaire.

### Activer et proteger l'insertion

Dans le `.env` du service GTBApi, conserver les memes variables `PG*` que pour
l'inventaire et ajouter `MEASUREMENTS_API_KEY`. Generer localement une cle
aleatoire, puis la conserver hors du depot et des exports de workflows :

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Copier cette valeur dans `MEASUREMENTS_API_KEY=...`, puis redemarrer GTBApi.
La cle doit contenir de 32 a 512 caracteres de jeton Bearer (par exemple les
64 caracteres hexadecimaux generes ci-dessus). Une cle non vide invalide empeche
le demarrage. L'en-tete `Authorization` est masque dans les journaux HTTP.
Ne jamais placer la cle dans l'URL ou le corps JSON.

Sans cle, la route renvoie **503**, tandis que les profils et lectures continuent
de fonctionner. Avec une cle configuree, une requete sans
`Authorization: Bearer <cle>` valide renvoie **401**, avant toute analyse du JSON
ou requete PostgreSQL.

Un **pool d'ecriture distinct** utilise les memes variables `PG*` ; le pool de
lecture de l'inventaire reste force en lecture seule. Les deux pools sont limites
et fermes a l'arret. Pour ce nouveau pool, le role `PGUSER` doit avoir CONNECT,
USAGE sur `public` et INSERT sur la table. Si ces deux premiers droits existent
deja, la commande supplementaire est, **a faire executer manuellement par
l'administrateur**, en adaptant le role si necessaire :

```sql
GRANT INSERT ON TABLE public.mesures_rs485 TO gtb_api_user;
```

Aucun droit SELECT supplementaire n'est requis pour inserer : la route ne fait
pas de `RETURNING`. Conserver SELECT sur `public.gtb_sensors` pour les listes de
passerelles. Pour conserver le compte web cordongtb en lecture seule sur
l'historique, preferer un role collecteur distinct dans le `PGUSER` de GTBApi,
sans modifier le `PGUSER` de cordongtb.

**Ne pas exposer directement ce service a Internet.** Utiliser HTTPS via un proxy
ou un tunnel chiffre pour proteger la cle en transit ; HTTP simple ne chiffre
ni la cle ni les mesures. Les autres routes Modbus conservent leur protection
reseau actuelle, cette cle ne les protege pas.

### Contrat JSON

URL de l'installation : `http://{{ip}}:7001/api/v1/meter/measurements`.
En-tetes : `Content-Type: application/json` et `Authorization: Bearer <cle>`.
Exemple documentaire (adresse reservee, pas un equipement reel) :

```json
{
  "time": "2026-10-05T14:00:00.123456+02:00",
  "capteur_id": 1,
  "valeur": 27.3,
  "site": "CORDON_SMB",
  "waveshare_ip": "192.0.2.10",
  "mesure": "temperature",
  "unite": "degC"
}
```

Les **sept champs sont obligatoires**, sans champs inconnus ni tableaux :

| Champ | Validation |
| --- | --- |
| `time` | ISO 8601 avec `Z` ou decalage horaire ; horodatage source transmis sans conversion JavaScript, precision PostgreSQL a la microseconde |
| `capteur_id` | Nombre entier positif, maximum 2147483647 ; pas une chaine numerique |
| `valeur` | Nombre fini, accepte zero, negatifs et decimales ; pas une chaine numerique |
| `site`, `mesure` | Texte non vide, espaces peripheriques retires, maximum 200 caracteres |
| `waveshare_ip` | Adresse IPv4 seule, sans masque ni nom DNS |
| `unite` | Texte, peut etre vide, espaces peripheriques retires, maximum 200 caracteres |

Le corps est limite a **16 Kio**, JSON non compresse. `capteur_id` est un
identifiant historique, pas necessairement un Unit ID : des valeurs superieures
a 247 restent valides. Pour votre workflow, il reprend explicitement `unit_id`.
Il n'y a ni recherche de profil ni substitution silencieuse de metadonnees.

Succes : **201 Created**, uniquement apres confirmation d'une ligne inseree :

```json
{ "inserted": 1 }
```

Erreurs : **400** (JSON, champs ou contraintes invalides), **401** (authentification),
**409** (eventuelle contrainte d'unicite en base), **413** (taille), **415** (type ou
encodage), **503** (fonction desactivee, configuration, droits ou connexion).
Les erreurs PostgreSQL sont journalisees par code sans exposer leur contenu.
Les echecs d'ecriture comportent `outcome: "not_inserted"` si PostgreSQL a refuse
la ligne, ou **`outcome: "unknown"`** si l'insertion n'est pas confirmee.

**Chaque appel insere, meme si la mesure existe deja.** Aucun retry automatique,
aucune deduplication ni cle d'idempotence. Si la reponse est perdue ou si
`outcome` vaut `unknown`, verifier l'historique avant de renvoyer : une ligne peut
deja etre presente. Des retries n8n peuvent donc creer des doublons, qui
participent ensuite aux agregations de l'historique.

### Remplacer le noeud PostgreSQL n8n

Ajouter un noeud **HTTP Request**, execute pour chaque item :

1. Methode **POST**, URL ci-dessus, avec l'IP reelle du service.
2. Authentication **Generic Credential Type > Header Auth** : nom
   `Authorization`, valeur `Bearer <votre cle>`. Stocker ceci dans les credentials
   n8n, pas dans un en-tete ecrit en clair dans le workflow.
3. **Send Body**, type **JSON**, **Using JSON** ; passer le champ entier en mode
   **Expression** et coller :

```javascript
={{ ({
  time: $json.timestamp,
  capteur_id: $json.unit_id,
  valeur: $json.value,
  site: "CORDON_SMB",
  waveshare_ip: $json.host,
  mesure: $json.metric,
  unite: $json.unit
}) }}
```

Cette expression conserve les types numeriques de `unit_id` et `value`, sans
conversion automatique de chaines, et reproduit les sept colonnes du noeud
PostgreSQL fourni. Le noeud HTTP renvoie `{ "inserted": 1 }` et non la ligne SQL.
Desactiver **Retry On Fail** si vous ne souhaitez pas de doublons automatiques.
Ne pas activer **Never Error** : les echecs doivent rester visibles dans n8n.

Validation locale sans base distante : `node --test test\measurements.test.js`.

## 6) PM2

```bash
npm run pm2:start
npm run pm2:logs
```

Stop:

```bash
npm run pm2:stop
```

## Endpoints

- `GET /health`
- `GET /api/v1/meter/discover`
- `GET /api/v1/meter/discover-unitid`
- `GET /api/v1/meter/read`
- `GET /api/v1/meter/read-raw`
- `GET /api/v1/meter/profiles`
- `GET /api/v1/meter/read-profile`
- `POST /api/v1/meter/change-unitid` (Eastron SDM120CT, mode SET confirme)
- `POST /api/v1/meter/measurements` (insertion historique, cle Bearer obligatoire)

Option de publication MQTT/GELF a la demande:
- `GET /api/v1/meter/read?host=...&publish=true`

Publication periodique (background):
- definir `POLL_INTERVAL_MS` (>0) et `MODBUS_HOST` dans `.env`
