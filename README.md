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

Option de publication MQTT/GELF a la demande:
- `GET /api/v1/meter/read?host=...&publish=true`

Publication periodique (background):
- definir `POLL_INTERVAL_MS` (>0) et `MODBUS_HOST` dans `.env`
