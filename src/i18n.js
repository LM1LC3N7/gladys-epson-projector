// -----------------------------------------------------------------------------
// Texts shown to the user (action messages, connection status), in English and
// French. Never a password in them.
// -----------------------------------------------------------------------------

const list = (names) => names.join(', ');
const both = (en, fr) => ({ en, fr });

export const T = {
  dataReset: both(
    'The saved data of the integration was unreadable: it was moved to epson-projector.json.bad and the projectors must be found again.',
    "Les données enregistrées de l'intégration étaient illisibles : elles ont été déplacées dans epson-projector.json.bad et les vidéoprojecteurs doivent être retrouvés.",
  ),
  invalidEntries: (entries) =>
    both(
      `Ignored in the configuration (invalid): ${list(entries)}.`,
      `Ignoré dans la configuration (invalide) : ${list(entries)}.`,
    ),
  passwordInvalid: both(
    'The password of the configuration cannot be used: ESC/VP.net accepts 16 characters at most, without accents. It is ignored.',
    'Le mot de passe de la configuration est inutilisable : ESC/VP.net accepte 16 caractères au plus, sans accents. Il est ignoré.',
  ),
  authRequired: (names) =>
    both(
      `A password is set on: ${list(names)}. Type it in the configuration (tried again every 30 minutes, or when the configuration is saved).`,
      `Un mot de passe est défini sur : ${list(names)}. Saisissez-le dans la configuration (nouvel essai toutes les 30 minutes, ou à l'enregistrement de la configuration).`,
    ),
  authRefused: (names) =>
    both(
      `Password refused by: ${list(names)}. Check it in the configuration (tried again every 30 minutes, or when the configuration is saved).`,
      `Mot de passe refusé par : ${list(names)}. Vérifiez-le dans la configuration (nouvel essai toutes les 30 minutes, ou à l'enregistrement de la configuration).`,
    ),
  noAnswerAt: (addresses) =>
    both(
      `No Epson projector answers at: ${list(addresses)} (tried again every minute).`,
      `Aucun vidéoprojecteur Epson ne répond à : ${list(addresses)} (nouvel essai chaque minute).`,
    ),
  unreachable: (names) =>
    both(
      `Unreachable (off, standby without network, or wrong address): ${list(names)}.`,
      `Injoignables (éteints, en veille sans réseau, ou mauvaise adresse) : ${list(names)}.`,
    ),
  addressUnknown: (names) =>
    both(
      `Another projector now answers at the address of: ${list(names)}. Type its new address or use "Find the projectors".`,
      `Un autre vidéoprojecteur répond maintenant à l'adresse de : ${list(names)}. Saisissez sa nouvelle adresse ou utilisez « Chercher les vidéoprojecteurs ».`,
    ),
  found: (names) =>
    names.length === 0
      ? both(
          'No Epson projector found. Check that the network standby ("Standby Mode: Communication On") is enabled, and type the IP addresses in the configuration if the network blocks the search.',
          'Aucun vidéoprojecteur Epson trouvé. Vérifiez que la veille réseau (« Mode attente : Communication activée ») est activée, et saisissez les adresses IP dans la configuration si le réseau bloque la recherche.',
        )
      : both(
          `${names.length} projector(s): ${list(names)}. They are in the Discovery tab.`,
          `${names.length} vidéoprojecteur(s) : ${list(names)}. Ils sont dans l'onglet Découverte.`,
        ),
  searchFailed: both(
    'The network search through Gladys failed (or was asked too soon): the typed addresses were checked.',
    'La recherche réseau par Gladys a échoué (ou a été demandée trop tôt) : les adresses saisies ont été vérifiées.',
  ),
  noProjector: both(
    'No projector known yet: type their address in the configuration or use "Find the projectors".',
    "Aucun vidéoprojecteur connu pour l'instant : saisissez leur adresse dans la configuration ou utilisez « Chercher les vidéoprojecteurs ».",
  ),
  check: (lines) => both(lines.map((l) => l.en).join(' · '), lines.map((l) => l.fr).join(' · ')),
  checkLine: (label, reading, problem) => {
    if (problem) {
      return both(`${label}: ${problem.en}`, `${label} : ${problem.fr}`);
    }
    if (!reading) {
      return both(`${label}: no answer (busy?)`, `${label} : pas de réponse (occupé ?)`);
    }
    if (reading.reachable === false) {
      return both(`${label}: unreachable`, `${label} : injoignable`);
    }
    const en = [reading.power?.label ?? 'state unknown'];
    const fr = [FR_LABELS[reading.power?.label] ?? 'état inconnu'];
    if (Number.isInteger(reading.lampHours)) {
      en.push(`lamp ${reading.lampHours} h`);
      fr.push(`lampe ${reading.lampHours} h`);
    }
    return both(`${label}: ${en.join(', ')}`, `${label} : ${fr.join(', ')}`);
  },
  busy: both('busy (a command is in progress)', 'occupé (une commande est en cours)'),
  passwordProblem: both('password missing or refused', 'mot de passe manquant ou refusé'),
};

const FR_LABELS = {
  Standby: 'en veille',
  On: 'allumé',
  'Warming up': 'en préchauffage',
  'Cooling down': 'en refroidissement',
  'Abnormal standby': 'veille anormale (voir le vidéoprojecteur)',
  'A/V standby': 'veille A/V',
};
