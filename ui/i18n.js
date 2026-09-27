'use strict';
// Display strings of the interface. Code stays English; only what the user sees is translated.
// The language comes from the engine (Windows display language, or the one picked in the menu).
(() => {
  const STRINGS = {
    en: {
      // Island
      'island.nothing_playing': 'Nothing playing',
      'island.muted': 'muted',
      'island.offline': 'offline',
      'island.charging': 'Charging',
      'island.on_battery': 'On battery',
      'island.connected': 'Connected',
      'island.network_lost': 'Network lost',
      'island.desktop': 'Desktop {name}',
      'island.back': 'Back',
      'island.now': 'now',
      'island.notifications': 'Notifications',
      'island.loading': 'Loading…',
      'island.no_notifications': 'No notifications',
      'island.clear_all': 'Clear all',
      'island.notification_center': 'Windows notification center',
      'island.delete': 'Delete',
      'island.close': 'Close',
      'island.today': 'Today',
      'island.prev_month': 'Previous month',
      'island.next_month': 'Next month',
      'island.weekdays': 'M,T,W,T,F,S,S',
      'time.just_now': 'just now',
      'time.minutes_ago': '{n} min ago',
      'time.hours_ago': '{n} h ago',
      'time.in_minutes': 'in {n} min',
      'time.in_hours': 'in {h} h {m}',
      // Claude
      'claude.session': 'Session',
      'claude.week': 'Week',
      'claude.resets': 'resets {when}',
      'claude.refresh': 'Refresh',
      'claude.rate_limited': 'Claude: too many requests for now',
      'claude.retry_at': ' (retry at {time})',
      'claude.open_claude_code': 'Claude: open Claude Code to refresh the usage',
      'claude.limit_reached': 'Claude session limit reached',
      'claude.session_80': 'Claude: 80% of the session used',
      // Status bar modules
      'bar.start_menu': 'Start menu',
      'bar.disconnected': 'Disconnected',
      'bar.glaze_missing': 'GlazeWM not found',
      'bar.glaze_open_page': 'click: open the project page',
      'bar.unknown_module': 'unknown module: {name}',
      'bar.memory_tooltip': '{used} GB / {total} GB used',
      'bar.cpu_tooltip': '{model}\n{cores} cores · {speed} GHz',
      'bar.disk_free': '{free} GB',
      'bar.disk_tooltip': '{path}: {used} / {total} GB ({percentage}%)',
      'bar.power.lock': 'Lock',
      'bar.power.sleep': 'Sleep',
      'bar.power.logout': 'Sign out',
      'bar.power.restart': 'Restart',
      'bar.power.shutdown': 'Shut down',
      'bar.power.confirm': '{label}? (click again)',
      'bar.weekdays': 'mo,tu,we,th,fr,sa,su',
    },
    fr: {
      'island.nothing_playing': 'Aucune lecture en cours',
      'island.muted': 'muet',
      'island.offline': 'hors ligne',
      'island.charging': 'En charge',
      'island.on_battery': 'Sur batterie',
      'island.connected': 'Connecté',
      'island.network_lost': 'Réseau perdu',
      'island.desktop': 'Bureau {name}',
      'island.back': 'Retour',
      'island.now': 'maintenant',
      'island.notifications': 'Notifications',
      'island.loading': 'Chargement…',
      'island.no_notifications': 'Aucune notification',
      'island.clear_all': 'Tout effacer',
      'island.notification_center': 'Centre de notifications Windows',
      'island.delete': 'Supprimer',
      'island.close': 'Fermer',
      'island.today': "Aujourd'hui",
      'island.prev_month': 'Mois précédent',
      'island.next_month': 'Mois suivant',
      'island.weekdays': 'L,M,M,J,V,S,D',
      'time.just_now': "à l'instant",
      'time.minutes_ago': 'il y a {n} min',
      'time.hours_ago': 'il y a {n} h',
      'time.in_minutes': 'dans {n} min',
      'time.in_hours': 'dans {h} h {m}',
      'claude.session': 'Session',
      'claude.week': 'Semaine',
      'claude.resets': 'réinit. {when}',
      'claude.refresh': 'Actualiser',
      'claude.rate_limited': "Claude : trop de requêtes pour l'instant",
      'claude.retry_at': ' (nouvel essai à {time})',
      'claude.open_claude_code': "Claude : ouvre Claude Code pour actualiser l'utilisation",
      'claude.limit_reached': 'Limite de session Claude atteinte',
      'claude.session_80': 'Claude : 80 % de la session',
      'bar.start_menu': 'Menu Démarrer',
      'bar.disconnected': 'Déconnecté',
      'bar.glaze_missing': 'GlazeWM non détecté',
      'bar.glaze_open_page': 'clic : ouvrir la page du projet',
      'bar.unknown_module': 'module inconnu : {name}',
      'bar.memory_tooltip': '{used} Go / {total} Go utilisés',
      'bar.cpu_tooltip': '{model}\n{cores} cœurs · {speed} GHz',
      'bar.disk_free': '{free} Go',
      'bar.disk_tooltip': '{path} : {used} / {total} Go ({percentage}%)',
      'bar.power.lock': 'Verrouiller',
      'bar.power.sleep': 'Veille',
      'bar.power.logout': 'Se déconnecter',
      'bar.power.restart': 'Redémarrer',
      'bar.power.shutdown': 'Éteindre',
      'bar.power.confirm': '{label} ? (re-cliquer)',
      'bar.weekdays': 'lu,ma,me,je,ve,sa,di',
    },
  };

  let lang = 'en';

  window.i18n = {
    get lang() { return lang; },
    /** Sets the language (falls back to English) and the matching date locale. */
    setLang(code) {
      lang = STRINGS[code] ? code : 'en';
      document.documentElement.lang = lang;
      dayjs.locale(lang);
    },
    /** Translated string with {name} placeholders replaced. */
    t(key, vars = {}) {
      const text = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
      return text.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? vars[name] : m));
    },
  };
})();
