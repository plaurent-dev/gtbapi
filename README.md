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

Option de publication MQTT/GELF a la demande:
- `GET /api/v1/meter/read?host=...&publish=true`

Publication periodique (background):
- definir `POLL_INTERVAL_MS` (>0) et `MODBUS_HOST` dans `.env`
