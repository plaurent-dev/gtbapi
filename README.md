# GTB API (Modbus TCP -> HTTP)

API Node.js pour lire un compteur via le convertisseur Waveshare RS485-to-POE-Eth(B) et exposer les mesures en REST.

## Carte STM8 quatre relais

Le profil `stm8-4relay` cible le firmware compatible avec
[la variante STM8 quatre relais de modbus_relay](https://github.com/eddyem/eddys_snippets/tree/master/modbus_relay).
Il ne couvre pas automatiquement toutes les cartes STM8/N76E003 : verifier la
table Modbus du vendeur. La compatibilite de la carte photographiee reste a
confirmer sur materiel. Aucun registre interne UART/GPIO du microcontroleur
n'est expose par ce profil.

- Lecture `GET /api/v1/meter/read-profile?host=...&port=4196&unitId=1&profile=stm8-4relay` :
  FC01, coils 0 a 3, resultat `relay_1` a `relay_4` avec valeurs 0/1.
- Commande `POST /api/v1/meter/write-relay`, JSON strict :
  `{"host":"10.107.31.5","port":4196,"unitId":1,"profile":"stm8-4relay","relay":1,"state":true,"commandConfirmed":true}`.
  `relay` va de 1 a 4, `state` est un booleen. Lecture prealable, puis FC05
  a l'adresse `relay - 1`, une seule fois, puis relecture FC01.
  `verified: true` confirme l'etat logique, pas la position physique du contact.
- Un echec apres tentative d'ecriture donne HTTP 502 : l'etat peut avoir change.
  Ne pas repeter automatiquement ; relire et verifier avant de recommander.
  Une autre commande simultanee sur la meme passerelle est refusee (409).
- Aucune commande globale, broadcast, changement d'adresse ou debit.
  Configurer la passerelle selon la documentation du firmware (l'utilitaire cite
  utilise par defaut 9600 bauds, 8N1, adresse 1), sans changement automatique.
  Le transport reste Modbus TCP via la passerelle existante, pas UART TTL direct.

Les entrees IN1 a IN4 ont une lecture independante :
`GET /api/v1/meter/read-relay-inputs?host=...&port=4196&unitId=1&profile=stm8-4relay`.
Elle utilise uniquement FC02, adresse 0, quantite 8 bits, et retourne uniquement IN1 a IN4 :
`data: {input_1: 0, input_2: 1, input_3: 0, input_4: 1}`, la cible et l'horodatage.
Les bits sont restitues sans inversion ; le cablage/firmware determine leur
signification physique. Une erreur ou une reponse invalide donne HTTP 502
avec un message explicite, sans etat OFF fictif et sans bloquer FC01/FC05.
La quantite de 8 suit l'exemple de la rubrique 11 de la
[notice du vendeur](https://fr.aliexpress.com/item/1005008904384687.html#nav-description),
qui demande huit bits meme si seuls quatre sont affiches. Les bits 4 a 7 ne
sont pas exposes. La lecture reste a confirmer sur la carte reelle. La lecture des relais
et leurs commandes ne lisent pas les entrees.

Cette API Modbus n'authentifie pas ses appels : la garder sur un reseau prive,
accessible uniquement aux services autorises, jamais exposee publiquement.
La console Cordon GTB authentifie et reserve ces commandes aux administrateurs.
Deployer et redemarrer les deux services pour utiliser les controles.

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

### Collecte LoRaWAN avec ChirpStack v4

La collecte est **desactivee par defaut**, independante de `MQTT_ENABLED`
(publication Modbus). Elle synchronise les passerelles et tous les capteurs
accessibles dans un tenant ChirpStack via l'API gRPC officielle, puis consomme
les uplinks JSON `application/+/device/+/event/up` de l'integration MQTT
ChirpStack. Pas de REST optionnel ni de trames Protobuf de statistiques
passerelle a configurer dans GTBApi.

1. Installer la migration `012_lorawan.sql` du portail et ses droits dans la
   **meme base PostgreSQL** utilisee par les deux services ; voir le README du
   portail. Aucune migration ni modification du materiel n'est automatique.
2. Dans ChirpStack, creer une cle d'API **limitee au tenant concerne** et
   autorisee a lister passerelles, applications et capteurs. Recuperer l'UUID
   du tenant. La cle reste uniquement dans l'environnement du serveur GTBApi :
   ne pas la mettre dans le navigateur, Git ou un ticket.
3. Renseigner les variables `LORAWAN_*` de `.env.example`, ainsi que `PG*`.
   `LORAWAN_API_SERVER` est l'adresse gRPC `hote:port`, sans `http://`.
   `LORAWAN_API_TLS=true` est le choix normal. Si ChirpStack expose uniquement
   gRPC sans TLS, `false` n'est acceptable que sur une liaison locale ou un
   reseau prive de confiance : la cle traverse alors le reseau en clair.
   Utiliser `mqtts://` et un certificat valide pour un broker distant. Les
   identifiants MQTT se renseignent separement de l'URL.
4. Donner au compte MQTT le droit de lecture des topics applicatifs utiles.
   Restreindre les ACL du broker aux applications du tenant : le filtre MQTT
   couvre tous les IDs visibles par ce compte et GTBApi rejette les messages
   dont le tenant, l'application ou le DevEUI ne correspondent pas au contenu
   et au topic. Utiliser un `LORAWAN_MQTT_CLIENT_ID` stable et unique par
   instance ; deux instances portant le meme ID se deconnectent mutuellement.
5. Activer `LORAWAN_ENABLED=true`, redemarrer GTBApi et le portail, puis
   consulter l'etat dans Supervision et les journaux GTBApi. L'endpoint local
   `GET /api/v1/lorawan/status` expose uniquement l'etat du service, pas les
   identifiants. Comme les autres routes GTBApi, il doit rester sur un reseau
   prive ; le portail requiert une session pour le consulter.

Une erreur de configuration ou d'initialisation LoRaWAN est signalee dans
l'etat et les journaux sans empecher le demarrage de la partie Modbus.
La synchronisation est paginee, limitee a 10000 equipements par type et
transactionnelle. Une erreur laisse l'inventaire precedent intact. Un element
disparu est marque absent, jamais supprime : ses placements et son historique
restent disponibles. L'etat de passerelle est celui rapporte par ChirpStack
lors de la derniere synchronisation, pas une preuve de connectivite instantanee.
La reception et le decodage sont horodates distinctement ; sans heure source,
l'interface indique explicitement l'heure de reception.

Pour le [Dragino LDS02](https://docs.dragino.com/docs/LoRaWAN-End-Node/door-water-leak-contact-sensors/lds02/),
le profil nomme exactement `LDS02` ou `Dragino-LDS02` decode la trame FPort 10
de 10 octets : porte (0 fermee, 1 ouverte), tension de pile, nombre d'ouvertures,
duree de la derniere ouverture et bit d'alarme. Pour un autre nom de profil,
indiquer son UUID dans `LORAWAN_LDS02_PROFILE_IDS` (liste separee par des
virgules). Les autres ports ne creent pas d'etat de porte fictif. Pour les
autres capteurs, les nombres et booleens de premier niveau de `object`
(decode par ChirpStack) sont historises sans supposer d'unite ; une trame
sans decodeur reste archivee mais indiquee comme non decodee.

Les rediffusions du meme `deduplicationId` ne dupliquent pas les mesures.
L'abonnement demande QoS 1, avec session MQTT persistante, et l'accuse de
reception suit l'ecriture PostgreSQL pour les publications QoS 1. Toutefois
la QoS effective ne peut pas depasser celle du **publieur ChirpStack** : si
celui-ci publie en QoS 0, les trames peuvent etre perdues pendant une panne.
Aucune garantie d'exactement-une-fois ni de rattrapage universel n'est promise.

## 3) Demarrage local

```bash
npm run dev
```

### PM2 en developpement avec Cordon GTB

Depuis le dossier GTBApi :

```powershell
pm2 start ecosystem.dev.config.js
```

Cette configuration lance `gtb-api-dev` en mode `development` sur le port
7001, attendu par la configuration dev de Cordon GTB. PostgreSQL utilise
`localhost:5432`, base `gtb_db_restore`. Ces valeurs priment sur `.env` ;
`PGUSER` et `PGPASSWORD` restent fournis par l'environnement ou `.env`.
La base locale doit deja contenir les tables du projet.
Le polling automatique est desactive (`POLL_INTERVAL_MS=0`), mais les appels
HTTP de lecture et de commande continuent de viser les equipements reels.
Garder cette API sans authentification sur un reseau prive, sans exposition
publique. La configuration de production reste inchangee.

Pour appliquer des modifications :

```powershell
pm2 restart ecosystem.dev.config.js --update-env
```

Verifier que l'API repond avec
`http://localhost:7001/api/v1/meter/profiles`.

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
