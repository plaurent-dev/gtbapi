# Recap setup Modbus GTBApi

Date: 2026-09-21

## Contexte reseau

- Passerelles Waveshare RS485 to ETH(B) utilisees:
  - `192.168.1.19` (profil POLIER)
  - `192.168.1.20` (profil EASTRON)
- Port Modbus TCP: `4196`
- IP de parametrage initiale du nouveau module: `192.168.1.254`
- Mot de passe interface web Waveshare: `admin`

## Endpoints disponibles

### 1) Discover IP

URL:

`http://localhost:3000/api/v1/meter/discover?subnet=192.168.1&from=1&to=254&port=4196&verifyModbus=true`

Exemple de resultat:

```json
{
  "count": 2,
  "result": [
    {
      "host": "192.168.1.19",
      "port": 4196,
      "modbusVerified": true,
      "serial_number": 0
    },
    {
      "host": "192.168.1.20",
      "port": 4196,
      "modbusVerified": false
    }
  ]
}
```

### 2) Discover Unit ID (scan complet)

URL:

`http://localhost:3000/api/v1/meter/discover-unitid?host=192.168.1.20`

### 3) Discover Unit ID (plage ciblee)

URL:

`http://localhost:3000/api/v1/meter/discover-unitid?host=192.168.1.19&fromUnitId=90&toUnitId=92&timeoutMs=400&probe=both`

Exemple de resultat:

```json
{"target":{"host":"192.168.1.19","port":4196},"range":{"fromUnitId":90,"toUnitId":92},"probe":"both","count":1,"result":[{"unitId":91,"method":"holding","address":0,"value":[0]}]}
```

### 4) Lecture brute Modbus

Endpoint: `GET /api/v1/meter/read-raw`

Parametres:

- `host` (obligatoire)
- `unitId` (obligatoire)
- `port` (optionnel, defaut 4196)
- `type` (`holding` ou `input`, optionnel, defaut `input`)
- `address` (optionnel, defaut 0)
- `count` (optionnel, defaut 2)
- `timeoutMs` (optionnel)

Exemples:

- `http://localhost:3000/api/v1/meter/read-raw?host=192.168.1.19&unitId=91&type=holding&address=0&count=1`
- `http://localhost:3000/api/v1/meter/read-raw?host=192.168.1.20&unitId=1&type=input&address=0&count=2`

### 5) Liste des profils

URL:

`http://localhost:3000/api/v1/meter/profiles`

### 6) Lecture profilee (valeurs traduites)

URLs:

- `http://localhost:3000/api/v1/meter/read-profile?host=192.168.1.20&profile=eastron-sdm120ct&unitId=1`
- `http://localhost:3000/api/v1/meter/read-profile?host=192.168.1.19&profile=polier-mm80lmzmod&unitId=91`

## Etat actuel

- Communication Modbus OK sur POLIER (`192.168.1.19`, unit id `91`).
- Communication Modbus et profil EASTRON OK (`192.168.1.20`, unit id `1`).
- Parametres serie fonctionnels observes pour EASTRON: `9600 / 8 / None / 1 / Flow none`.

## Notes cablage utiles

- Cote Waveshare:
  - borne `485B` <-> `B-` compteur
  - borne `485A` <-> `A+` compteur
  - ne rien brancher sur `NC`
- Pince CT:
  - S1 (white) et S2 (black) correctement raccordes
  - la pince doit entourer un seul conducteur (phase uniquement), pas phase+neutre+terre ensemble

## Test prevu au travail (checklist)

1. Verifier que la pince entoure uniquement la phase.
2. Appliquer une charge suffisante (ex: >500W).
3. Lire:
   - `read-profile` EASTRON
   - `current_a`, `active_power_w`, `import_energy_kwh`
4. Confirmer la coherence des valeurs.
