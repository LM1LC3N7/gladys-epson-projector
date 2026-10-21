# Vidéoprojecteurs Epson pour Gladys

Pilotez vos **vidéoprojecteurs Epson** (home cinéma EH-TW / EH-LS,
professionnels EB…) depuis Gladys, en local, sans aucun cloud : allumage,
veille, source, mode couleur, sourdine A/V, et les heures de lampe (ou de
source lumineuse).

> **Important.** Cette intégration n'a jamais été testée avec un vrai appareil :
> elle a été écrite à partir de la bibliothèque `epson-projector` (celle de
> Home Assistant) et du protocole publié par Epson, et testée seulement avec
> un faux vidéoprojecteur. Vos retours sont les bienvenus. Intégration non
> officielle, sans lien avec Epson.

## Installation

1. Sur le vidéoprojecteur, activez la **veille réseau** : selon le modèle,
   _Réglages_ ou _ECO_ > **Mode attente : Communication activée** (ou _Veille
   réseau_). Sans elle, le vidéoprojecteur quitte le réseau en veille et ne
   peut pas être allumé depuis Gladys.
2. Donnez à chaque vidéoprojecteur une **adresse IP fixe** dans votre box
   (bail DHCP réservé).
3. Dans Gladys, installez l'intégration **Epson Projector**, puis ouvrez sa
   configuration.
4. Saisissez les adresses IP, séparées par des virgules (par exemple
   `192.168.1.50, 192.168.1.51`). Le bouton **Chercher les vidéoprojecteurs**
   peut aussi les chercher sur le réseau (facultatif : la recherche ne
   traverse pas tous les réseaux).
5. Si un mot de passe protège le contrôle réseau de vos vidéoprojecteurs,
   saisissez-le (16 caractères au plus, le même pour tous).
6. Les vidéoprojecteurs apparaissent dans l'onglet **Découverte** : créez-les.

L'intégration parle au vidéoprojecteur en **ESC/VP.net** (port TCP 3629), le
protocole de contrôle réseau publié par Epson, et lit son état à l'intervalle
de rafraîchissement de la configuration (30 s par défaut). Elle n'utilise pas
la télécommande web du vidéoprojecteur.

## Ce que vous obtenez

| Fonction        | Type Gladys                  | Remarque                                                               |
| --------------- | ---------------------------- | ---------------------------------------------------------------------- |
| Marche          | état binaire (lecture seule) | 1 allumé ou en préchauffage, 0 en veille, refroidissement, injoignable |
| Allumer         | bouton                       | envoyé seulement depuis la veille                                      |
| Veille          | bouton                       | envoyé seulement quand il est allumé                                   |
| État            | texte (lecture seule)        | Standby, Warming up, On, Cooling down, Abnormal standby…               |
| Source          | liste                        | HDMI1, HDMI2, Computer, Video, USB, LAN, Screen mirroring…             |
| Mode couleur    | liste                        | Cinema, Natural, Dynamic, Bright Cinema, Game…                         |
| Sourdine A/V    | bouton (sourdine)            | chaque appui lit l'état, puis règle l'inverse                          |
| Heures de lampe | durée en heures              | les heures de source lumineuse sur les modèles laser                   |

Volontairement, pas d'**interrupteur** : un « tout éteindre » ou « tout
allumer » d'un assistant vocal ou d'une scène n'allume ni ne coupe votre
vidéoprojecteur.

Source, mode couleur et sourdine A/V ne sont lus et réglés que lorsque le
vidéoprojecteur est allumé. Les sources et modes couleur proposés dépendent du
modèle : une valeur refusée par le modèle est signalée « refusée par le
vidéoprojecteur ». Une source ou un mode couleur affiché par le
vidéoprojecteur et encore inconnu de la liste y est ajouté de lui-même
(utilisez « Mettre à jour » dans Gladys pour le voir).

## Commandes

Chaque commande lit d'abord l'état de marche du vidéoprojecteur, et décide
d'après lui :

- **Allumer** n'est envoyé que depuis la veille ; déjà allumé ou en
  préchauffage, rien n'est envoyé. Pendant le refroidissement (ou en veille
  anormale), rien n'est envoyé et la raison est donnée.
- **Veille** n'est envoyé que lorsque le vidéoprojecteur est allumé.
- Le vidéoprojecteur ne confirme une commande de marche qu'à la fin de son
  préchauffage ou de son refroidissement (jusqu'à 40 s). Quand c'est plus long
  que ce qu'attend Gladys, Gladys affiche « Sent; … confirms it after warming
  up (up to 40 s): without confirmation yet » (envoyée, pas encore confirmée :
  un message d'erreur dans Gladys, bien que la commande soit partie), et les
  états Marche et État sont mis à jour dès la confirmation. En attendant, toute
  autre commande vers ce vidéoprojecteur est refusée aussitôt, « rien n'a été
  envoyé ».
- Après une absence (injoignable, ou redémarrage de l'intégration), le numéro
  de série du vidéoprojecteur est relu avant une commande ou une publication :
  un vidéoprojecteur qui répond un autre numéro à cette adresse n'est jamais
  pris pour le vôtre. Beaucoup de modèles ne donnent pas leur numéro de série
  en veille : c'est accepté (état affiché, Allumer fonctionne), et revérifié
  une fois le vidéoprojecteur allumé. Un vidéoprojecteur allumé qui ne donne
  pas de numéro de série affiche « Identity not confirmed » dans son État et
  dans le statut de l'intégration, et ne reçoit rien (« identity not
  confirmed, nothing sent ») tant qu'il ne répond pas le vôtre.

Chaque commande reçoit une réponse en moins de 4 secondes (Gladys attend
5 secondes), sans jamais attendre que Gladys enregistre les états. Une
commande partie vers le vidéoprojecteur sans confirmation est signalée
« envoyée, sans confirmation » ; une commande qui n'a pas pu partir est
signalée « rien n'a été envoyé » (en anglais dans Gladys : « nothing sent »),
et n'est alors jamais envoyée plus tard. Un état qui n'a pas pu être lu avant
une commande donne « … not read in time, nothing sent ».

« Vérifier les vidéoprojecteurs », et une mise à jour de l'appareil dans
Gladys, n'interrogent jamais un vidéoprojecteur plus tôt que l'intervalle de
rafraîchissement : la dernière lecture est affichée.

## Mot de passe

ESC/VP.net peut être protégé par un mot de passe sur le vidéoprojecteur. Un
mot de passe manquant ou refusé arrête l'intégration pour ce vidéoprojecteur
(le statut de l'intégration le dit) : il est réessayé toutes les 30 minutes,
ou dès que vous enregistrez la configuration, jamais en boucle. Le mot de
passe est gardé par Gladys dans sa base, jamais réaffiché, envoyé seulement à
vos vidéoprojecteurs sur votre réseau local (ESC/VP.net le transmet en texte
lisible), et jamais écrit dans les journaux ni dans le dossier de données de
l'intégration.

## Boutons de la configuration

- **Chercher les vidéoprojecteurs** : une diffusion HELLO sur le réseau par
  Gladys (port UDP 3629), puis les adresses saisies.
- **Vérifier les vidéoprojecteurs** : l'état et les heures de lampe de chaque
  vidéoprojecteur.

## Données et vie privée

L'intégration garde dans `/data/epson-projector.json` la liste des
vidéoprojecteurs connus (identifiant, adresse, nom, codes vus) et les blocages
de mot de passe (adresse et heure du prochain essai, jamais le mot de passe).
Rien ne quitte votre réseau local.

## Limites connues

- Un seul mot de passe pour tous les vidéoprojecteurs.
- Un vidéoprojecteur qui ne donne pas de numéro de série est identifié par son
  adresse : si elle change, il devient un nouvel appareil.
- Pas encore d'objectif, de trapèze, de volume, de gel d'image ni de réglages
  d'image.
- Jamais testée avec un vrai appareil : les vraies réponses peuvent différer.
