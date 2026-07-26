/**
 * renderer.js — Moteur de rendu VexFlow pour la partition piano
 *
 * Responsabilités :
 *  - Dessiner le grand staff (clé de Sol + clé de Fa) dans un SVG
 *  - Stocker les bounding boxes de chaque note pour le clic
 *  - Dessiner le highlight de la note sélectionnée
 *  - Notifier le callback lors d'un clic sur une note
 */

'use strict';

class ScoreRenderer {
  /* ── Configuration ──────────────────────────────────────────────────── */
  static STAVE_W = 260;   // largeur d'une mesure standard
  static FIRST_EXTRA = 70;    // largeur supplémentaire pour la clé + chiffrage
  static MEASURES_ROW = 4;     // mesures par ligne
  static TREBLE_Y_OFF = 30;    // offset treble depuis le haut de la ligne
  static STAVE_GAP = 85;    // espace entre le bas du treble et le haut du bass
  static ROW_HEIGHT = 280;   // hauteur totale d'une ligne (sans pédale)
  static PEDAL_EXTRA_ROW_HEIGHT = 34; // espace additionnel réservé par ligne quand la pédale est affichée
  static MARGIN_X = 20;
  static MARGIN_Y = 16;

  /**
   * Hauteur effective d'une ligne. Quand la pédale est affichée, on réserve
   * davantage d'espace entre les lignes (BUG CORRIGÉ v4.2 : sans cette marge
   * supplémentaire, l'annotation de pédale d'une ligne pouvait se mélanger
   * avec la portée de main droite de la ligne suivante).
   */
  _rowHeight() {
    return ScoreRenderer.ROW_HEIGHT + (this.showPedals ? ScoreRenderer.PEDAL_EXTRA_ROW_HEIGHT : 0);
  }

  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.noteMap = new Map();   // id → { bb, noteData, measureIndex, hand, idx }
    this._clickCb = null;
    this._scoreData = null;
    this.lastHighlightedNoteId = null;
    this.lastHighlightedKeyIdx = null;

    // Cases à cocher UI : afficher/masquer la pédale, les noms d'accords
    // et les noms de notes aigües sans re-transcrire (débrayage instantané, cf. index.html / app.js).
    this.showPedals = true;
    this.showChordSymbols = true;
    this.showHighestNote = true;  // nom de la note la plus haute en français (désactivé par défaut)

    // Debounced resize handler for responsive re-render
    window.addEventListener('resize', () => {
      if (this._scoreData) {
        if (this._resizeTimeout) clearTimeout(this._resizeTimeout);
        this._resizeTimeout = setTimeout(() => {
          this.render(this._scoreData);
          if (this.showHighestNote && typeof this.renderHighestNoteLabels === 'function') {
            this.renderHighestNoteLabels();
          }
        }, 150);
      }
    });
  }

  /** Enregistre le callback appelé lors d'un clic sur une note. */
  onNoteClick(cb) { this._clickCb = cb; }

  /* ── Rendu principal ────────────────────────────────────────────────── */
  render(scoreData) {
    if (!scoreData || !scoreData.measures || scoreData.measures.length === 0) {
      this.container.innerHTML = '<p style="padding:40px;color:#888">Aucune note à afficher.</p>';
      return;
    }

    /* Sauvegarder la position de scroll du conteneur défilant */
    const scrollEl = this.container.closest('.score-wrapper') || this.container.parentElement;
    const savedScrollTop = scrollEl ? scrollEl.scrollTop : 0;
    const savedScrollLeft = scrollEl ? scrollEl.scrollLeft : 0;

    this._scoreData = scoreData;
    this.container.innerHTML = '';
    this.noteMap.clear();

    const VF = Vex.Flow;
    const measures = scoreData.measures;

    // ── Filet de sécurité : valider l'armure avant de la transmettre à VexFlow ──
    // BUG CORRIGÉ (v4.2) : quelle que soit l'origine exacte d'une armure mal
    // formée (bug backend résiduel, ancien cache, edge-case non prévu...),
    // on ne veut plus jamais planter tout le rendu (page blanche) à cause
    // d'un unique champ invalide. VexFlow accepte un format strict du type
    // "C", "F#", "Bb", "Am", "C#m", "Ebm"... : lettre A-G, altération
    // optionnelle (# ou b, simple ou double), suffixe 'm' optionnel pour le
    // mineur. Toute valeur hors de ce format est ignorée (repli sur "do
    // majeur", sans armure affichée) plutôt que de faire planter VexFlow.
    const VALID_KEY_SIG_RE = /^[A-G](#{1,2}|b{1,2})?m?$/;
    const rawKeySig = scoreData.keySignature;
    const safeKeySignature = (typeof rawKeySig === 'string' && VALID_KEY_SIG_RE.test(rawKeySig))
      ? rawKeySig
      : null;
    if (rawKeySig && rawKeySig !== 'C' && !safeKeySignature) {
      console.warn(`[ScoreRenderer] Armure invalide reçue du backend : "${rawKeySig}" — affichage sans armure pour éviter un crash.`);
    }

    // Calculer le nombre de mesures par ligne (MPR)
    // this._forcedMPR permet de court-circuiter le calcul responsive (ex: export PDF)
    let MPR;
    if (this._forcedMPR) {
      MPR = this._forcedMPR;
    } else {
      const parentWidth = this.container.parentElement ? this.container.parentElement.clientWidth : 1200;
      const availableW = parentWidth - 48; // padding/marge
      const fit = Math.floor((availableW - ScoreRenderer.MARGIN_X * 2 - ScoreRenderer.FIRST_EXTRA) / ScoreRenderer.STAVE_W);
      MPR = Math.max(1, Math.min(5, fit));
    }
    this._currentMPR = MPR; // mémorisé pour enableDragDrop

    const rows = Math.ceil(measures.length / MPR);

    /* Calcul des dimensions totales du SVG */
    const svgW = MPR * ScoreRenderer.STAVE_W + ScoreRenderer.FIRST_EXTRA + ScoreRenderer.MARGIN_X * 2;
    const svgH = rows * this._rowHeight() + ScoreRenderer.MARGIN_Y * 2 + 30;

    /* Création du rendu VexFlow (backend SVG) */
    const renderer = new VF.Renderer(this.container, VF.Renderer.Backends.SVG);
    renderer.resize(svgW, svgH);
    const ctx = renderer.getContext();
    ctx.setFont('Arial', 10, '');

    for (let row = 0; row < rows; row++) {
      const rowY = row * this._rowHeight() + ScoreRenderer.MARGIN_Y;
      const rowMeasures = measures.slice(row * MPR, (row + 1) * MPR);

      for (let col = 0; col < rowMeasures.length; col++) {
        const measure = rowMeasures[col];
        const measureIndex = row * MPR + col;
        const isFirstRow = col === 0;
        const isFirstAll = measureIndex === 0;

        /* Position X de la mesure */
        const staveX = isFirstRow
          ? ScoreRenderer.MARGIN_X
          : ScoreRenderer.MARGIN_X + ScoreRenderer.FIRST_EXTRA + col * ScoreRenderer.STAVE_W;

        const staveW = isFirstRow
          ? ScoreRenderer.STAVE_W + ScoreRenderer.FIRST_EXTRA
          : ScoreRenderer.STAVE_W;

        /* ── Treble stave ───────────────────────────────────────────── */
        const trebleY = rowY + ScoreRenderer.TREBLE_Y_OFF;
        const trebleStave = new VF.Stave(staveX, trebleY, staveW);
        if (isFirstRow) {
          trebleStave.addClef('treble');
          if (safeKeySignature && safeKeySignature !== 'C') {
            trebleStave.addKeySignature(safeKeySignature);
          }
        }
        if (isFirstAll) {
          trebleStave.addTimeSignature(
            `${scoreData.timeSignature[0]}/${scoreData.timeSignature[1]}`
          );
        }
        trebleStave.setContext(ctx).draw();

        /* ── Bass stave ─────────────────────────────────────────────── */
        const bassY = trebleY + 40 + ScoreRenderer.STAVE_GAP;
        const bassStave = new VF.Stave(staveX, bassY, staveW);
        if (isFirstRow) {
          bassStave.addClef('bass');
          if (safeKeySignature && safeKeySignature !== 'C') {
            bassStave.addKeySignature(safeKeySignature);
          }
        }
        if (isFirstAll) {
          bassStave.addTimeSignature(
            `${scoreData.timeSignature[0]}/${scoreData.timeSignature[1]}`
          );
        }
        bassStave.setContext(ctx).draw();

        /* ── Connecteurs (accolade + barre gauche) ──────────────────── */
        if (isFirstRow) {
          const brace = new VF.StaveConnector(trebleStave, bassStave);
          brace.setType(VF.StaveConnector.type.BRACE);
          brace.setContext(ctx).draw();

          const leftBar = new VF.StaveConnector(trebleStave, bassStave);
          leftBar.setType(VF.StaveConnector.type.SINGLE_LEFT);
          leftBar.setContext(ctx).draw();
        }

         /* ── Rendu conjoint des voix Treble et Bass pour alignement rythmique parfait ── */
        /* ── P6 : Collecter les IDs de notes incertaines depuis scoreData ── */
        const uncertainIds = new Set(
          (scoreData.uncertainNotes && Array.isArray(scoreData.uncertainNotes))
            ? scoreData.uncertainNotes
            : []
        );

        try {
          this._renderJointVoices(
            ctx,
            trebleStave,
            bassStave,
            measure.treble || [],
            measure.bass || [],
            measureIndex,
            scoreData,
            uncertainIds,  // P6 : propager les IDs incertains
            safeKeySignature  // ✅ Passer l'armure validée pour applyAccidentals()
          );
        } catch (e) {
          console.warn('[Renderer] Erreur rendu conjoint mesure', measureIndex, e);
        }

        /* ── Accords Jazz (chordSymbols) ──────────────────────────────── */
        if (this.showChordSymbols && scoreData.chordSymbols && scoreData.chordSymbols.length > 0) {
          this._renderChordSymbols(ctx, trebleStave, scoreData.chordSymbols, measureIndex, MPR);
        }

        /* ── Notes les plus hautes de la main droite (pour aider les débutants) ── */
        // NOTE : Le rendu des noms est maintenant délégué à renderHighestNoteLabels()
        // en post-rendu, pour utiliser getBBox() des noteheads réels.
      }
    }

    /* ── Pédales (pedalMarkings) ────────────────────────────────────────── */
    if (this.showPedals && scoreData.pedalMarkings && scoreData.pedalMarkings.length > 0) {
      this._renderPedalMarkings(ctx, scoreData, MPR);
    }

    /* Gestion des clics : toujours réattacher car le SVG est recréé à chaque render */
    this._attachClickHandler();

    /* Restaurer le surlignage de la note sélectionnée (utile lors du resize) */
    if (this.lastHighlightedNoteId) {
      this.highlightNote(this.lastHighlightedNoteId, this.lastHighlightedKeyIdx);
    }

    /* Restaurer la position de scroll (évite le saut au début lors d'une édition) */
    if (scrollEl) {
      scrollEl.scrollTop = savedScrollTop;
      scrollEl.scrollLeft = savedScrollLeft;
    }
  }

  /* ── Rendu conjoint des voix Treble et Bass pour alignement rythmique parfait ── */
  _renderJointVoices(ctx, trebleStave, bassStave, trebleNotesData, bassNotesData, measureIndex, scoreData, uncertainIds, keySignature) {
    // P6 : uncertainIds est un Set d'IDs de notes incertaines (fallback single-model)
    // Si non fourni ou vide, aucun traitement spécial
    const hasUncertain = uncertainIds && uncertainIds.size > 0;
    const VF = Vex.Flow;
    const keySig = keySignature || 'C';  // ✅ Utiliser l'armure passée en argument (ou 'C' par défaut)
    const [num, den] = scoreData.timeSignature;

    // 1. Créer les StaveNotes
    const trebleStaveNotes = trebleNotesData.map(nd => this._buildStaveNote(nd, 'treble'));
    const bassStaveNotes = bassNotesData.map(nd => this._buildStaveNote(nd, 'bass'));

    // 2. Créer les voix VexFlow
    // On garde setStrict(false) pour éviter que VexFlow ne crashe si la mesure dépasse le temps,
    // MAIS on pad avec des GhostNotes pour garantir que le temps minimal est atteint.
    const trebleVoice = new VF.Voice({ num_beats: num, beat_value: den }).setStrict(false);
    const bassVoice = new VF.Voice({ num_beats: num, beat_value: den }).setStrict(false);

    if (trebleStaveNotes.length > 0) trebleVoice.addTickables(trebleStaveNotes);
    if (bassStaveNotes.length > 0) bassVoice.addTickables(bassStaveNotes);

    // --- ALIGNEMENT VERTICAL STRICT & ALERTES DE DÉPASSEMENT ---
    const trebleRequired = trebleVoice.getTotalTicks();
    const trebleUsed = trebleVoice.getTicksUsed();
    const bassRequired = bassVoice.getTotalTicks();
    const bassUsed = bassVoice.getTicksUsed();

    // 1. Alerte visuelle : si une main dépasse le temps réglementaire, on colore ses notes en rouge pâle
    if (trebleUsed.value() > trebleRequired.value()) {
      trebleStaveNotes.forEach(n => n.setStyle({ fillStyle: "#ef4444", strokeStyle: "#ef4444" })); // Rouge
    }
    if (bassUsed.value() > bassRequired.value()) {
      bassStaveNotes.forEach(n => n.setStyle({ fillStyle: "#ef4444", strokeStyle: "#ef4444" })); // Rouge
    }

    // 2. Comblement pour garantir que le Formatter a deux voix strictement de même longueur
    let maxTicks = trebleRequired.clone();
    if (trebleUsed.value() > maxTicks.value()) maxTicks = trebleUsed.clone();
    if (bassUsed.value() > maxTicks.value()) maxTicks = bassUsed.clone();

    const padVoiceTo = (voice, staveNotesList, targetTicks) => {
      if (staveNotesList.length === 0) return;
      const used = voice.getTicksUsed();
      if (used.value() < targetTicks.value()) {
        try {
          const missing = targetTicks.clone().subtract(used);
          const ghost = new VF.GhostNote({ duration: "q" });
          ghost.ticks = missing; // Surcharge du nombre de ticks pour correspondre au trou
          voice.addTickables([ghost]);
        } catch (e) {
          console.warn('[Renderer] Impossible de padder la voix:', e);
        }
      }
    };

    padVoiceTo(trebleVoice, trebleStaveNotes, maxTicks);
    padVoiceTo(bassVoice, bassStaveNotes, maxTicks);

    // Altérations automatiques
    // ✅ Utiliser keySig (désormais correctement passé depuis render())
    if (trebleStaveNotes.length > 0) {
      try { VF.Accidental.applyAccidentals([trebleVoice], keySig); } catch (_) { }
    }
    if (bassStaveNotes.length > 0) {
      try { VF.Accidental.applyAccidentals([bassVoice], keySig); } catch (_) { }
    }

    // 3. Beaming (croches / doubles-croches) — AMÉLIORÉ
    // RÈGLE MUSICALE : un trait de ligature ne peut pas enjamber un silence
    // ni une note de valeur ≥ noire (q, h, w et leurs pointées).
    // On segmente donc la voix en "streaks" de croches/doubles-croches strictement
    // contigues (sans silence ni longue note entre elles), et on appelle
    // generateBeams séparément sur chaque streak.
    // NOUVEAU : regroupement intelligent par temps (beat) pour respecter
    // la pulsation naturelle (ex: 4 doubles-croches par temps en 4/4).
    const BEAMABLE_DURS = new Set(['8', '16', '32']); // durées ligaturables
    const customBeamsMap = scoreData.customBeams || {};
    const processBeams = (staveNotes, notesData, hand) => {
      let beams = [];
      try {
        const customBeamGroups = {};

        // --- Segmentation en streaks contigus ---
        // Chaque fois qu'on rencontre un silence OU une note non-ligurable,
        // on ferme le streak courant.
        const streaks = [];   // tableau de tableaux de StaveNote
        let currentStreak = [];

        staveNotes.forEach((sn, idx) => {
          const nd = notesData[idx];
          if (!nd) return;

          const groupId = customBeamsMap[nd.id];
          if (groupId) {
            // Note dans un groupe personnalisé → hors auto-beam
            // Elle interrompt aussi le streak courant
            if (currentStreak.length > 0) {
              streaks.push(currentStreak);
              currentStreak = [];
            }
            if (groupId !== 'none') {
              if (!customBeamGroups[groupId]) customBeamGroups[groupId] = [];
              customBeamGroups[groupId].push(sn);
            }
          } else if (!nd.isRest && BEAMABLE_DURS.has(nd.durationStr)) {
            // Note ligurable → ajouter au streak courant
            currentStreak.push(sn);
          } else {
            // Silence OU note longue (noire, blanche, ronde…) → briser le streak
            if (currentStreak.length > 0) {
              streaks.push(currentStreak);
              currentStreak = [];
            }
          }
        });
        if (currentStreak.length > 0) streaks.push(currentStreak);

        // --- Générer les beams streak par streak avec regroupement par temps ---
        const beatValue = den === 8 ? 3 : 1;
        const beatUnit = den === 8 ? 8 : 4;
        streaks.forEach(streak => {
          if (streak.length >= 2) {
            try {
              // Regroupement intelligent : si toutes les notes sont des doubles-croches,
              // on les groupe par 4 (un temps complet en 4/4)
              const allSixteenth = streak.every((sn, i) => {
                const nd = notesData[staveNotes.indexOf(sn)];
                return nd && nd.durationStr === '16';
              });
              
              if (allSixteenth && streak.length >= 4) {
                // Grouper par paquets de 4 doubles-croches (1 temps)
                const groups = [];
                for (let g = 0; g < streak.length; g += 4) {
                  const subgroup = streak.slice(g, Math.min(g + 4, streak.length));
                  if (subgroup.length >= 2) {
                    groups.push(new VF.Fraction(subgroup.length * beatValue, beatUnit * 4));
                  }
                }
                if (groups.length > 0) {
                  const streakBeams = VF.Beam.generateBeams(streak, {
                    groups: groups,
                    stem_direction: hand === 'treble' ? 1 : -1,
                    beam_rests: false,
                  });
                  beams = beams.concat(streakBeams);
                }
              } else {
                // Comportement standard pour les croches et mélanges
                const streakBeams = VF.Beam.generateBeams(streak, {
                  groups: [new VF.Fraction(beatValue, beatUnit)],
                  stem_direction: hand === 'treble' ? 1 : -1,
                  beam_rests: false,
                });
                beams = beams.concat(streakBeams);
              }
            } catch (_) { }
          }
          // streak de 1 seule note : pas de beam (noire isolée)
        });

        // --- Groupes personnalisés ---
        Object.keys(customBeamGroups).forEach(gId => {
          const notesInGroup = customBeamGroups[gId];
          if (notesInGroup.length >= 2) {
            beams.push(new VF.Beam(notesInGroup));
          }
        });
      } catch (_) { }
      return beams;
    };


    const trebleBeams = processBeams(trebleStaveNotes, trebleNotesData, 'treble');
    const bassBeams = processBeams(bassStaveNotes, bassNotesData, 'bass');

    // 4. ALIGNEMENT RYTHMIQUE CONJOINT (FORMATTER)

    // ── GARDE-FOU SYNCHRONISATION HORIZONTALE (noteStartX) ─────────────────
    // La clé de Sol et la clé de Fa ont des largeurs légèrement différentes dans
    // VexFlow : leur getNoteStartX() peut diverger de quelques pixels, ce qui
    // provoquerait un décalage horizontal des notes même avec un formatter parfait.
    // On force les deux portées à partager le même noteStartX (le plus grand)
    // AVANT de calculer availW et de formater les voix.
    const trebleNSX = trebleStave.getNoteStartX();
    const bassNSX   = bassStave.getNoteStartX();
    const maxNSX    = Math.max(trebleNSX, bassNSX);
    if (Math.abs(trebleNSX - bassNSX) > 0) {
      // setNoteStartX est disponible dans VexFlow 4.x ; accès direct en fallback
      if (typeof trebleStave.setNoteStartX === 'function') trebleStave.setNoteStartX(maxNSX);
      else trebleStave.noteStartX = maxNSX;
      if (typeof bassStave.setNoteStartX   === 'function') bassStave.setNoteStartX(maxNSX);
      else bassStave.noteStartX = maxNSX;
    }

    const availW   = trebleStave.getX() + trebleStave.getWidth() - maxNSX - 12;
    const formatter = new VF.Formatter();

    // ── GARDE-FOU SYNCHRONISATION MAIN GAUCHE / MAIN DROITE (FORMATTER) ────
    // Règle VexFlow pour le grand staff :
    //  • joinVoices([voix...]) → résolution des collisions INTRA-portée
    //    (chaque portée gère ses propres voix séparément)
    //  • format([toutesLesVoix], width) → grille X PARTAGÉE entre portées
    // ATTENTION : joinVoices([treble, bass]) en un seul appel traiterait les deux
    // portées comme concurrentes sur la MÊME portée — résultat incorrect.
    const activeVoices = [];
    if (trebleNotesData.length > 0) activeVoices.push(trebleVoice);
    if (bassNotesData.length > 0)   activeVoices.push(bassVoice);

    try {
      if (trebleNotesData.length > 0) formatter.joinVoices([trebleVoice]);
      if (bassNotesData.length   > 0) formatter.joinVoices([bassVoice]);
      if (activeVoices.length    > 0) {
        // format() avec les deux voix crée la grille X commune → alignement parfait
        formatter.format(activeVoices, Math.max(availW, 60));
      }
    } catch (e) {
      console.warn('[Renderer] Formatter conjoint :', e.message);
    }

    // 5. Dessiner les voix
    // Plus besoin d'intercepter openGroup, VexFlow assigne directement les IDs définis dans _buildStaveNote

    // Dessiner main droite
    if (trebleNotesData.length > 0) {
      try {
        trebleVoice.draw(ctx, trebleStave);
        trebleBeams.forEach(b => b.setContext(ctx).draw());
      } catch (e) { console.warn('[Renderer] Draw treble conjoint :', e.message); }
    }

    // Dessiner main gauche
    if (bassNotesData.length > 0) {
      try {
        bassVoice.draw(ctx, bassStave);
        bassBeams.forEach(b => b.setContext(ctx).draw());
      } catch (e) { console.warn('[Renderer] Draw bass conjoint :', e.message); }
    }

    // ── Centrage des pauses (silences seuls dans une mesure) ────────────────
    // VexFlow place le silence au début de la mesure ; on le translate au centre.
    // BUG CORRIGÉ : VexFlow 4.x préfixe lui-même les IDs avec "vf-", donc le vrai
    // ID dans le DOM est "vf-vf-{id}" (confirmé par highlightNote qui essaie
    // getElementById('vf-vf-' + id) en premier). L'ancienne recherche '#vf-{id}'
    // ne trouvait rien → le silence restait collé à gauche.
    const centerWholeRest = (notesData, staveNotesList, stave) => {
      if (notesData.length !== 1 || !notesData[0].isRest) return;
      const nd  = notesData[0];
      const svg = this.container.querySelector('svg');
      if (!svg) return;

      // Chercher l'élément SVG avec tous les formats de préfixe possibles
      const groupEl =
        svg.querySelector('#vf-vf-' + nd.id) ||   // VexFlow 4.x (préfixe double)
        svg.querySelector('#vf-' + nd.id)     ||   // Ancien format
        svg.querySelector('[id$="' + nd.id + '"]'); // Fallback générique

      if (!groupEl) return;
      try {
        const bbox = groupEl.getBBox();
        if (!bbox || bbox.width === 0) return; // Élément non rendu, abandonner

        const noteStartX  = stave.getNoteStartX();
        const staveEndX   = stave.getX() + stave.getWidth();
        const staveCenter = (noteStartX + staveEndX) / 2;
        const noteCenter  = bbox.x + bbox.width / 2;
        const dx = staveCenter - noteCenter;

        if (Math.abs(dx) > 1) {
          const currentTransform = groupEl.getAttribute('transform') || '';
          groupEl.setAttribute('transform', currentTransform + ` translate(${dx}, 0)`);
        }
      } catch (_) { }
    };

    // On attend que le DOM soit mis à jour (le draw() est synchrone en SVG VexFlow)
    centerWholeRest(trebleNotesData, trebleStaveNotes, trebleStave);
    centerWholeRest(bassNotesData, bassStaveNotes, bassStave);

    // 6. Enregistrement des éléments dans le DOM pour le clic et le surlignage
    const svg = this.container.querySelector('svg');

    const registerDOMInteractions = (staveNotes, notesData, hand) => {
      staveNotes.forEach((sn, i) => {
        const nd = notesData[i];
        try {
          // VexFlow 4.x: after draw(), the element is in the SVG with the id we set via sn.setAttribute
          let el = svg ? svg.querySelector('#vf-' + nd.id) : null;
          if (!el && svg) el = svg.querySelector('[id$="' + nd.id + '"]');

          let bb = null;
          if (el) {
            try {
              const bbox = el.getBBox();
              bb = { x: bbox.x, y: bbox.y, w: bbox.width, h: bbox.height };
            } catch (_) { }
          }

          let vfX = null;
          let vfY = null;
          try {
            if (sn.getAbsoluteX) {
              vfX = sn.getAbsoluteX();
            } else if (sn.getNoteHeadBeginX && sn.getNoteHeadEndX) {
              vfX = (sn.getNoteHeadBeginX() + sn.getNoteHeadEndX()) / 2;
            } else if (sn.getX) {
              vfX = sn.getStave().getX() + sn.getX();
            }
            if (sn.getYs && sn.getYs().length > 0) {
              vfY = Math.min(...sn.getYs());
            } else if (sn.getStave) {
              vfY = sn.getStave().getYForLine(0);
            }
          } catch (e) {
            console.error('[NoteLabel] Error extracting vfX/vfY:', e);
          }

          let vfStaveY = null;
          try {
            if (sn.getStave) vfStaveY = sn.getStave().getY();
          } catch (_) {}

          const info = { el, bb, vfX, vfY, vfStaveY, noteData: nd, measureIndex, hand, idx: i };

          // ── Stocker les noms de notes treble (toujours, depuis les données) ──
          // IMPORTANT : cette logique ne doit PAS dépendre de la présence de `el`
          // car l'élément SVG peut ne pas être encore trouvé lors de l'enregistrement.
          if (!nd.isRest && hand === 'treble' && nd.keys && nd.keys.length > 0) {
            const VF_FR = { C:'Do', D:'Ré', E:'Mi', F:'Fa', G:'Sol', A:'La', B:'Si' };
            const vfToFr = k => {
              const m = k.match(/^([a-gA-G])(#{1,2}|b{1,2})?/);
              if (!m) return k;
              const letter = m[1].toUpperCase();
              const altMap = { '##':'x', '#':'♯', 'bb':'bb', 'b':'♭' };
              const acc = altMap[m[2]] || '';
              return (VF_FR[letter] || letter) + acc;
            };
            const midiFromKey = k => {
              const m = k.match(/^([a-gA-G])(#{1,2}|b{1,2})?\/([0-9]+)/);
              if (!m) return 0;
              const letter = m[1].toUpperCase();
              const s = { C:0,D:2,E:4,F:5,G:7,A:9,B:11 }[letter] || 0;
              const a = m[2] ? (m[2][0]==='#' ? m[2].length : -m[2].length) : 0;
              return parseInt(m[3], 10) * 12 + s + a;
            };
            // Trier du plus aigu au plus grave
            const names = [...nd.keys]
              .sort((a, b) => midiFromKey(b) - midiFromKey(a))
              .map(vfToFr);
            info.trebleNoteNames = names;
          }

          this.noteMap.set(nd.id, info);

          if (el) {
            el.setAttribute('id', 'vf-' + nd.id);
            el.setAttribute('class', nd.isRest ? 'vf-rest' : 'vf-notehead');

            // P6 : Marquer les notes incertaines avec une bordure pointillée orange
            if (hasUncertain && uncertainIds.has(nd.id)) {
              el.setAttribute('class', el.getAttribute('class') + ' uncertain');
              el.setAttribute('data-uncertain', 'true');

              // Ajouter un highlight SVG autour de la note
              if (bb && bb.w > 0 && bb.h > 0) {
                const highlight = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                highlight.setAttribute('class', 'uncertain-highlight');
                highlight.setAttribute('x', bb.x - 4);
                highlight.setAttribute('y', bb.y - 4);
                highlight.setAttribute('width', bb.w + 8);
                highlight.setAttribute('height', bb.h + 8);
                highlight.setAttribute('rx', '4');
                highlight.setAttribute('fill', 'none');
                highlight.setAttribute('stroke', '#f59e0b');
                highlight.setAttribute('stroke-width', '1.5');
                highlight.setAttribute('stroke-dasharray', '3,2');
                highlight.setAttribute('stroke-opacity', '0.8');
                highlight.setAttribute('pointer-events', 'none');
                highlight.setAttribute('data-parent-id', nd.id);

                // Insérer avant le notehead pour qu'il soit en dessous
                if (el.parentNode) {
                  el.parentNode.insertBefore(highlight, el);
                }
              }

              info.isUncertain = true;
            } else {
              info.isUncertain = false;
            }

            if (!nd.isRest) {
              const heads = el.querySelectorAll('.vf-notehead');
              info.numHeads = heads.length || (nd.keys ? nd.keys.length : 1);
            }
          }
        } catch (err) {
          console.warn('[Renderer] Enregistrement interactif conjoint error:', nd.id, err);
        }
      });
    };

    registerDOMInteractions(trebleStaveNotes, trebleNotesData, 'treble');
    registerDOMInteractions(bassStaveNotes, bassNotesData, 'bass');
  }

  /* ── Construction d'un StaveNote VexFlow ───────────────────────────── */
  _buildStaveNote(nd, hand) {
    const VF = Vex.Flow;
    const isRest = !!nd.isRest;
    const duration = isRest ? nd.durationStr + 'r' : nd.durationStr;

    // GARDE-FOU : forcer la direction des queues (stems) par main
    // - Main droite (treble) : queues TOUJOURS vers le haut (stem_direction = 1)
    // - Main gauche (bass)   : queues TOUJOURS vers le bas (stem_direction = -1)
    // Cela résout le bug où la direction changeait aléatoirement selon la hauteur de la note.
    const stem_direction = hand === 'treble' ? 1 : -1;

    // Correction octave pour la clé de Fa (bass clef)
    // VexFlow interprète les octaves une octave trop bas avec la clef de Fa.
    // On ajoute +1 à l'octave pour compenser.
    // IMPORTANT : ne PAS décaler les silences (isRest) — leur position verticale
    // dépend de leur durée et ne doit pas être modifiée.
    let keys = nd.keys;
    if (hand === 'bass' && !nd.isRest) {
      keys = nd.keys.map(k => {
        const parts = k.split('/');
        if (parts.length === 2 && !isNaN(parseInt(parts[1]))) {
          return parts[0] + '/' + (parseInt(parts[1]) + 1);
        }
        return k;
      });
    }

    const sn = new VF.StaveNote({
      keys: keys,
      duration: duration,
      dots: nd.dots || 0,
      clef: hand,
      stem_direction: stem_direction,
    });

    /* Points */
    for (let d = 0; d < (nd.dots || 0); d++) {
      sn.addModifier(new VF.Dot(), 0);
    }

    // [P-Arp] Accolade ondulée pour accords arpégés
    if (nd.isArpeggio) {
      // NOTE: User requested UP direction always, but we'll use arpeggioDirection if provided,
      // which defaults to 'up' in score_builder anyway.
      const direction = nd.arpeggioDirection === 'down'
        ? VF.Stroke.Type.ROLL_DOWN
        : VF.Stroke.Type.ROLL_UP;
      sn.addModifier(new VF.Stroke(direction), 0);
    }

    sn.setAttribute('id', 'vf-' + nd.id);
    sn.setAttribute('class', isRest ? 'vf-rest' : 'vf-notehead');

    return sn;
  }

  /* ── Highlight des notes sélectionnées ─────────────────────────────── */
  highlightNote(noteIdOrIds, keyIdx) {
    const svg = this.container.querySelector('svg');
    if (!svg) return;

    /* Retrait de tous les anciens highlights de sélection */
    svg.querySelectorAll('.editor-selected-highlight').forEach(h => h.remove());

    if (!noteIdOrIds) {
      this.lastHighlightedNoteId = null;
      this.lastHighlightedKeyIdx = null;
      return;
    }

    const ids = Array.isArray(noteIdOrIds) ? noteIdOrIds : [noteIdOrIds];

    // Sauvegarder pour le resize (prend le premier)
    this.lastHighlightedNoteId = ids[0];
    this.lastHighlightedKeyIdx = keyIdx || 0;

    ids.forEach(id => {
      const el = document.getElementById('vf-vf-' + id) ||
        document.getElementById('vf-' + id) ||
        svg.querySelector('[id$="' + id + '"]');
      if (!el) return;

      let targetEl = el;
      if (keyIdx !== undefined && keyIdx !== null && !Array.isArray(noteIdOrIds)) {
        const heads = Array.from(el.querySelectorAll('.vf-notehead'));
        if (heads.length > keyIdx) {
          targetEl = heads[keyIdx];
        }
      }

      let bbox;
      try {
        bbox = targetEl.getBBox();
        if (!bbox || bbox.width === 0) {
          bbox = el.getBBox();
        }
      } catch (e) {
        try { bbox = el.getBBox(); } catch (_) { return; }
      }

      if (!bbox || bbox.width === 0 || bbox.height === 0) return;

      const PAD_X = 8, PAD_Y = 8;
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('class', 'editor-selected-highlight');
      rect.setAttribute('x', bbox.x - PAD_X);
      rect.setAttribute('y', bbox.y - PAD_Y);
      rect.setAttribute('width', bbox.width + PAD_X * 2);
      rect.setAttribute('height', bbox.height + PAD_Y * 2);
      rect.setAttribute('rx', '5');
      rect.setAttribute('fill', 'rgba(124,58,237,0.22)');
      rect.setAttribute('stroke', '#9f67ff');
      rect.setAttribute('stroke-width', '1.5');
      rect.setAttribute('pointer-events', 'none');

      svg.insertBefore(rect, svg.firstChild);
    });
  }

  clearHighlight() { this.highlightNote(null); }

  /* ── Drag & Drop SVG ────────────────────────────────────────────── */

  /**
   * Active le drag & drop des notes sur le SVG.
   * @param {ScoreEditor} editorRef — instance de l'éditeur
   */
  enableDragDrop(editorRef) {
    this._ddEditor = editorRef;
    let isDragging = false;
    let dragNoteId = null;
    let ghostEl = null;
    let indicatorEl = null;
    let _dropInfo = null;

    const getSvg = () => this.container.querySelector('svg');

    /* ── Mousedown : début du drag ─────────────────────────────────── */
    this.container.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      let walker = e.target;
      while (walker && walker !== this.container) {
        const id = walker.getAttribute?.('id');
        if (id) {
          let cleanId = id;
          while (cleanId.startsWith('vf-')) cleanId = cleanId.substring(3);
          const info = this.noteMap.get(cleanId);
          if (info && !info.noteData.isRest) {
            dragNoteId = cleanId;
            isDragging = true;
            const svg = getSvg();
            if (svg && info.bb) {
              ghostEl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
              ghostEl.setAttribute('class', 'drag-ghost');
              ghostEl.setAttribute('x', info.bb.x);
              ghostEl.setAttribute('y', info.bb.y);
              ghostEl.setAttribute('width', info.bb.w || 20);
              ghostEl.setAttribute('height', info.bb.h || 20);
              ghostEl.setAttribute('rx', '3');
              ghostEl.setAttribute('pointer-events', 'none');
              svg.appendChild(ghostEl);

              indicatorEl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
              indicatorEl.setAttribute('class', 'drop-indicator');
              indicatorEl.setAttribute('pointer-events', 'none');
              indicatorEl.style.display = 'none';
              svg.appendChild(indicatorEl);
            }
            e.preventDefault();
            break;
          }
        }
        walker = walker.parentNode;
      }
    });

    /* ── Mousemove : déplacement du ghost ──────────────────────────── */
    document.addEventListener('mousemove', (e) => {
      if (!isDragging || !dragNoteId) return;
      const svg = getSvg();
      if (!svg) return;

      const svgRect = svg.getBoundingClientRect();
      const vb = svg.viewBox?.baseVal;
      const scaleX = vb && vb.width > 0 ? vb.width / svgRect.width : 1;
      const scaleY = vb && vb.height > 0 ? vb.height / svgRect.height : 1;
      const svgX = (e.clientX - svgRect.left) * scaleX;
      const svgY = (e.clientY - svgRect.top) * scaleY;

      if (ghostEl) {
        ghostEl.setAttribute('x', svgX - 10);
        ghostEl.setAttribute('y', svgY - 10);
      }

      _dropInfo = this._findNearestDropTarget(svgX, svgY, dragNoteId);

      if (_dropInfo && indicatorEl) {
        const MPR = this._currentMPR || 4;
        const row = Math.floor(_dropInfo.measureIndex / MPR);
        const rowY = row * this._rowHeight() + ScoreRenderer.MARGIN_Y;
        const cx = _dropInfo.bb.x + (_dropInfo.bb.w || 20) / 2;
        indicatorEl.setAttribute('x1', cx);
        indicatorEl.setAttribute('y1', rowY);
        indicatorEl.setAttribute('x2', cx);
        indicatorEl.setAttribute('y2', rowY + this._rowHeight() - 20);
        indicatorEl.style.display = '';
      } else if (indicatorEl) {
        indicatorEl.style.display = 'none';
      }
    });

    /* ── Mouseup : drop ─────────────────────────────────────────────── */
    document.addEventListener('mouseup', () => {
      if (!isDragging || !dragNoteId) return;

      const svg = getSvg();
      if (ghostEl && svg) { ghostEl.remove(); ghostEl = null; }
      if (indicatorEl && svg) { indicatorEl.remove(); indicatorEl = null; }

      if (_dropInfo && editorRef && _dropInfo.noteId !== dragNoteId) {
        editorRef.moveNoteToBeat(
          dragNoteId,
          _dropInfo.measureIndex,
          _dropInfo.noteData.startBeat,
          _dropInfo.hand
        );
      }

      isDragging = false;
      dragNoteId = null;
      _dropInfo = null;
    });
  }

  /**
   * Retourne la note/silence la plus proche de (svgX, svgY) dans la noteMap,
   * en excluant la note en cours de drag (excludeId).
   */
  _findNearestDropTarget(svgX, svgY, excludeId) {
    let best = null;
    let bestDist = Infinity;
    const SNAP_RADIUS = 80;

    this.noteMap.forEach((info, id) => {
      if (id === excludeId || !info.bb) return;
      const cx = info.bb.x + (info.bb.w || 20) / 2;
      const cy = info.bb.y + (info.bb.h || 20) / 2;
      const dist = Math.hypot(svgX - cx, svgY - cy);
      if (dist < bestDist) {
        bestDist = dist;
        best = { ...info, noteId: id };
      }
    });

    return best && bestDist < SNAP_RADIUS ? best : null;
  }

  /* ── Surlignage pour la lecture (playback) ─────────────────────────── */
  highlightPlaybackNotes(noteIds) {
    const svg = this.container.querySelector('svg');
    if (!svg) return;

    // Retrait des anciens highlights de lecture
    svg.querySelectorAll('.playback-highlight').forEach(el => el.remove());
    const oldPlayhead = svg.querySelector('#score-playhead');
    if (oldPlayhead) oldPlayhead.remove();

    if (!noteIds || noteIds.length === 0) return;

    let firstBBox = null;
    let minMeasureIdx = Infinity;

    noteIds.forEach(id => {
      const el = document.getElementById('vf-vf-' + id) ||
        document.getElementById('vf-' + id) ||
        svg.querySelector('[id$="' + id + '"]');
      if (!el) return;

      let bbox;
      try {
        bbox = el.getBBox();
      } catch (e) {
        return;
      }
      if (!bbox || bbox.width === 0 || bbox.height === 0) return;

      const PAD_X = 6, PAD_Y = 6;

      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('class', 'playback-highlight');
      rect.setAttribute('x', bbox.x - PAD_X);
      rect.setAttribute('y', bbox.y - PAD_Y);
      rect.setAttribute('width', bbox.width + PAD_X * 2);
      rect.setAttribute('height', bbox.height + PAD_Y * 2);
      rect.setAttribute('rx', '4');
      rect.setAttribute('fill', 'rgba(245,158,11,0.22)');
      rect.setAttribute('stroke', '#f59e0b');
      rect.setAttribute('stroke-width', '1.5');
      rect.setAttribute('pointer-events', 'none');

      svg.insertBefore(rect, svg.firstChild);

      const info = this.noteMap.get(id);
      if (info) {
        if (info.measureIndex < minMeasureIdx) {
          minMeasureIdx = info.measureIndex;
          firstBBox = bbox;
        }
      }
    });

    // Dessiner le playhead vertical traversant le grand staff
    if (firstBBox && minMeasureIdx !== Infinity) {
      const parentWidth = this.container.parentElement ? this.container.parentElement.clientWidth : 1200;
      const availableW = parentWidth - 48;
      const fit = Math.floor((availableW - ScoreRenderer.MARGIN_X * 2 - ScoreRenderer.FIRST_EXTRA) / ScoreRenderer.STAVE_W);
      const MPR = Math.max(1, Math.min(5, fit));
      const row = Math.floor(minMeasureIdx / MPR);
      const rowY = row * this._rowHeight() + ScoreRenderer.MARGIN_Y;
      const trebleY = rowY + ScoreRenderer.TREBLE_Y_OFF;
      const bassY = trebleY + 40 + ScoreRenderer.STAVE_GAP;

      const x = firstBBox.x + firstBBox.width / 2;
      const y1 = trebleY - 10;
      const y2 = bassY + 50;

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('id', 'score-playhead');
      line.setAttribute('x1', x);
      line.setAttribute('y1', y1);
      line.setAttribute('x2', x);
      line.setAttribute('y2', y2);
      line.setAttribute('stroke', '#f59e0b');
      line.setAttribute('stroke-width', '2.5');
      line.setAttribute('pointer-events', 'none');
      line.setAttribute('style', 'filter: drop-shadow(0px 0px 4px rgba(245,158,11,0.6));');

      svg.appendChild(line);
    }
  }

  /* ── Gestion du clic ────────────────────────────────────────────────── */
  _attachClickHandler() {
    const svg = this.container.querySelector('svg');
    if (!svg || !this._clickCb) return;

    svg.style.cursor = 'default';

    svg.addEventListener('click', (e) => {
      // Recherche de l'ID de note en remontant le DOM depuis la cible du clic
      let target = e.target;
      let noteId = null;
      let info = null;
      let clickedKeyIdx = 0;

      // Remonter jusqu'à trouver un groupe de note connu dans la noteMap
      let walker = target;
      while (walker && walker !== svg) {
        let id = walker.getAttribute('id');
        if (id) {
          // Nettoyer tous les préfixes "vf-" pour retrouver l'UUID brut
          let cleanId = id;
          while (cleanId.startsWith('vf-')) {
            cleanId = cleanId.substring(3);
          }
          const found = this.noteMap.get(cleanId);
          if (found) {
            noteId = cleanId;
            info = found;
            target = walker;

            // Déterminer quel notehead a été cliqué précisément
            // Les noteheads internes ont la classe .vf-notehead
            const heads = Array.from(walker.querySelectorAll('.vf-notehead'));
            if (heads.length > 1) {
              // Trouver quel path/notehead contient le point cliqué
              const svgRect = svg.getBoundingClientRect();
              const clickX = e.clientX - svgRect.left;
              const clickY = e.clientY - svgRect.top;

              let bestIdx = 0;
              let bestDist = Infinity;
              heads.forEach((head, hi) => {
                try {
                  const bb = head.getBBox();
                  const cx = bb.x + bb.width / 2;
                  const cy = bb.y + bb.height / 2;
                  // Récupérer le viewBox pour convertir les coordonnées SVG
                  const svgEl = svg;
                  const vb = svgEl.viewBox && svgEl.viewBox.baseVal;
                  let svgX = clickX, svgY = clickY;
                  if (vb && vb.width > 0) {
                    svgX = clickX * (vb.width / svgRect.width);
                    svgY = clickY * (vb.height / svgRect.height);
                  }
                  const dist = Math.abs(cy - svgY);
                  if (dist < bestDist) {
                    bestDist = dist;
                    bestIdx = hi;
                  }
                } catch (_) { }
              });
              clickedKeyIdx = bestIdx;
            } else {
              clickedKeyIdx = 0;
            }
            break;
          }
        }
        walker = walker.parentNode;
      }

      const targetDesc = `${e.target.tagName}${e.target.id ? '#' + e.target.id : ''}`;

      if (noteId && info) {
        e.stopPropagation();
        if (typeof showToast === 'function') {
          showToast(`Note/Silence sélectionné`, 'success', 2000);
        }
        this._clickCb(noteId, info, clickedKeyIdx, e);
      } else {
        if (typeof showToast === 'function') {
          showToast(`Clic hors note (Cible : ${targetDesc})`, 'info', 1500);
        }
        // Clic en dehors d'une note -> désélection
        this._clickCb(null, null, null, e);
      }
    });
  }

  /* ── Accords Jazz ───────────────────────────────────────────────────── */
  _renderChordSymbols(ctx, trebleStave, chordSymbols, measureIndex, MPR) {
    const svg = this.container.querySelector('svg');
    if (!svg) return;
    const chordsForMeasure = chordSymbols.filter(cs => cs.measure === measureIndex);
    if (chordsForMeasure.length === 0) return;

    const noteStartX = trebleStave.getNoteStartX();
    const noteEndX   = trebleStave.getNoteEndX ? trebleStave.getNoteEndX() : (trebleStave.getX() + trebleStave.getWidth());
    const noteWidth  = noteEndX - noteStartX;
    const staveY     = trebleStave.getY();
    const [tsNum]    = (this._scoreData && this._scoreData.timeSignature) || [4, 4];

    chordsForMeasure.forEach(cs => {
      const xFraction = tsNum > 0 ? cs.beatInMeasure / tsNum : 0;
      const x = noteStartX + xFraction * noteWidth;
      const y = staveY - 8;
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', x);
      text.setAttribute('y', y);
      text.setAttribute('font-family', 'Georgia, serif');
      text.setAttribute('font-size', '13');
      text.setAttribute('font-weight', 'bold');
      text.setAttribute('fill', '#1a56db');
      text.setAttribute('class', 'chord-symbol');
      text.setAttribute('text-anchor', 'middle');
      text.textContent = cs.symbol;
      svg.appendChild(text);
    });
  }

  /* ── Note la plus haute (pour aider les débutants) ─────────────────── */
  _renderHighestNote(ctx, trebleStave, highestNote, measureIndex, MPR) {
    const svg = this.container.querySelector('svg');
    if (!svg) return;

    const noteStartX = trebleStave.getNoteStartX();
    const noteEndX   = trebleStave.getNoteEndX ? trebleStave.getNoteEndX() : (trebleStave.getX() + trebleStave.getWidth());
    const noteWidth  = noteEndX - noteStartX;
    const staveY     = trebleStave.getY();

    // Position X : au début de la mesure, légèrement décalé pour éviter la clé
    const x = noteStartX + 5;

    // Position Y : au-dessus de la portée, bien au-dessus des notes
    // staveY = haut de la portée treble. Les accords sont à ~staveY - 8.
    // On place la note à staveY - 28 pour éviter tout chevauchement.
    const y = staveY - 28;

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', x);
    text.setAttribute('y', y);
    text.setAttribute('font-family', 'Arial, sans-serif');
    text.setAttribute('font-size', '12');
    text.setAttribute('font-weight', 'bold');
    text.setAttribute('fill', '#7c3aed');  // violet pour distinguer visuellement
    text.setAttribute('text-anchor', 'start');
    text.setAttribute('font-style', 'italic');
    text.textContent = highestNote;
    svg.appendChild(text);
  }

  /* ── Post-rendu : noms de notes (mode débutant) au-dessus du stem/beam ── */
  renderHighestNoteLabels() {
    const svg = this.container.querySelector('svg');
    if (!svg) return;

    const oldGroup = svg.querySelector('#highest-note-labels');
    if (oldGroup) oldGroup.remove();

    if (!this.showHighestNote) return;

    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('id', 'highest-note-labels');
    group.setAttribute('pointer-events', 'none');
    svg.appendChild(group);

    const FONT_SIZE = 11;
    const LABEL_GAP = 13;   // espace vertical entre les noms d'un accord
    const STEM_CLEARANCE = 6; // espace au-dessus du stem/beam

    // Trouve le Y du haut du stem d'une note
    const getStemTopY = (noteEl) => {
      if (!noteEl) return null;
      try {
        const stemEl = noteEl.querySelector('.vf-stem');
        if (stemEl) {
          const stemBBox = stemEl.getBBox();
          if (stemBBox && stemBBox.height > 0) return stemBBox.y;
        }
        // Fallback: chercher une path fine et haute (un stem)
        const paths = noteEl.querySelectorAll('path, rect');
        let bestStemY = null;
        paths.forEach(p => {
          try {
            const pb = p.getBBox();
            if (pb.width < 5 && pb.height > 15) {
              if (bestStemY === null || pb.y < bestStemY) bestStemY = pb.y;
            }
          } catch (_) {}
        });
        if (bestStemY !== null) return bestStemY;
        // Dernier fallback: haut du groupe entier
        const gb = noteEl.getBBox();
        if (gb && gb.height > 0) return gb.y;
      } catch (_) {}
      return null;
    };

    // Trouve le Y du haut de la barre de ligature (beam) qui couvre la note
    const getBeamTopY = (noteX, rowYTop, rowYBot) => {
      const beamGroups = svg.querySelectorAll('g.vf-beam');
      let bestBeamY = null;
      beamGroups.forEach(bg => {
        try {
          const bgBBox = bg.getBBox();
          // La beam doit être dans la même ligne horizontale
          if (bgBBox.y < rowYTop || bgBBox.y + bgBBox.height > rowYBot) return;
          // La beam doit couvrir la position X de la note
          if (noteX < bgBBox.x - 15 || noteX > bgBBox.x + bgBBox.width + 15) return;
          if (bestBeamY === null || bgBBox.y < bestBeamY) bestBeamY = bgBBox.y;
        } catch (_) {}
      });
      return bestBeamY;
    };

    this.noteMap.forEach((info, id) => {
      if (info.hand !== 'treble') return;
      if (!info.trebleNoteNames || info.trebleNoteNames.length === 0) return;

      // X précis depuis VexFlow
      let cx = 0;
      if (info.vfX !== null && info.vfX !== undefined) {
        cx = info.vfX;
      } else {
        return;
      }

      // Chercher l'élément SVG de la note (pour lire le stem)
      const noteEl = svg.querySelector('#vf-' + id) || svg.querySelector('[id$="' + id + '"]');

      // Y du haut du stem
      let stemTopY = getStemTopY(noteEl);
      if (stemTopY === null) {
        // Fallback sur les coordonnées VexFlow mathématiques
        if (info.vfY !== null && info.vfY !== undefined) {
          stemTopY = info.vfY - 10;
        } else if (info.staveY !== undefined && info.staveY !== null) {
          stemTopY = info.staveY - 10;
        } else {
          stemTopY = 50;
        }
      }

      // Bande verticale de la ligne courante (pour isoler les beams de cette ligne)
      const MPR = this._currentMPR || 4;
      const row = Math.floor(info.measureIndex / MPR);
      const rowYTop = row * this._rowHeight() + 20;
      const rowYBot = rowYTop + this._rowHeight();

      // Si la note fait partie d'un groupe lié (beam), utiliser le Y du beam
      const beamY = getBeamTopY(cx, rowYTop, rowYBot);
      const effectiveTopY = (beamY !== null && beamY < stemTopY) ? beamY : stemTopY;

      // Y de base du label (juste au-dessus du stem ou du beam) — aucun clamp artificiel.
      // Les noms de notes restent proches du beam, les accords seront ajustés au-dessus.
      let baseLabelY = effectiveTopY - STEM_CLEARANCE;

      const names = info.trebleNoteNames;

      // Empilement vertical: note grave en bas (baseLabelY), note aiguë en haut
      names.forEach((name, i) => {
        // names[0] = note la plus aiguë, names[N-1] = note la plus grave
        const y = baseLabelY - ((names.length - 1 - i) * LABEL_GAP);

        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', cx);
        text.setAttribute('y', y);
        text.setAttribute('font-family', 'Arial, sans-serif');
        text.setAttribute('font-size', String(FONT_SIZE));
        text.setAttribute('font-weight', 'bold');
        text.setAttribute('fill', '#7c3aed');
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('font-style', 'italic');
        text.textContent = name;
        group.appendChild(text);
      });

      // Post-traitement : pousser les chord symbols AU-DESSUS des noms de notes.
      // topLabelY est la baseline du label le plus aigu. Le texte monte visuellement
      // d'environ FONT_SIZE pixels au-dessus de la baseline, donc on ajoute FONT_SIZE + 6.
      const topLabelY = baseLabelY - ((names.length - 1) * LABEL_GAP);
      const desiredChordY = topLabelY - FONT_SIZE - 6;
      const chordTexts = svg.querySelectorAll('.chord-symbol');
      chordTexts.forEach(ct => {
        try {
          const ctX = parseFloat(ct.getAttribute('x') || '0');
          const ctY = parseFloat(ct.getAttribute('y') || '0');
          // Même ligne (bande verticale) + proximité horizontale
          if (Math.abs(ctX - cx) < 60 && ctY >= rowYTop && ctY <= rowYBot) {
            // Ne déplacer que vers le haut (jamais vers le bas)
            if (ctY > desiredChordY) {
              ct.setAttribute('y', String(desiredChordY));
            }
          }
        } catch (_) {}
      });
    });
  }

  /* ── Supprimer les labels de notes les plus hautes ─────────────────── */
  clearHighestNoteLabels() {
    const svg = this.container.querySelector('svg');
    if (!svg) return;
    const group = svg.querySelector('#highest-note-labels');
    if (group) group.remove();
  }

  /* ── Pédales ────────────────────────────────────────────────────────── */
  /**
   * BUGS CORRIGÉS (v4.1) :
   * - Les annotations de pédale pouvaient chevaucher les notes graves de la
   *   main gauche (surtout celles avec lignes supplémentaires en dessous de
   *   la portée de Fa) car elles étaient placées à un décalage FIXE sous la
   *   portée. On calcule désormais l'étendue verticale réelle (getBBox) du
   *   contenu de chaque mesure pour positionner "Ped." / "*" nettement en
   *   dessous de tout ce qui est déjà dessiné.
   * - Le trait horizontal de tenue ("ligne de pédale") a été supprimé à la
   *   demande : seuls "Ped." (début) et "*" (fin) restent affichés, ce qui
   *   allège la partition. Les crochets verticaux (ticks), qui n'avaient de
   *   sens qu'accolés à ce trait, ont été retirés avec lui.
   */
  _renderPedalMarkings(ctx, scoreData, MPR) {
    const svg = this.container.querySelector('svg');
    if (!svg) return;
    const [tsNum] = scoreData.timeSignature || [4, 4];
    const beatsPerMeasure = tsNum;
    const totalMeasures = scoreData.measures.length;
    const MIN_CLEARANCE = 14; // marge minimale sous le contenu de la mesure

    // ── Passe 1 : une position Y unique par LIGNE ────────────────────────
    // BUG CORRIGÉ (v4.2) : la position Y était calculée mesure par mesure,
    // en suivant le contenu ("le flow") de chaque mesure individuellement.
    // Résultat : sur une même ligne, les annotations "Ped."/"*" n'étaient
    // pas au même niveau horizontal (contrairement à l'usage classique où
    // toutes les indications de pédale d'une ligne sont alignées), et une
    // mesure à notes très graves pouvait pousser sa pédale jusque sous la
    // portée de la ligne suivante. On calcule maintenant l'étendue verticale
    // de TOUTE la ligne en une fois, et cette même valeur sert à toutes les
    // annotations de cette ligne.
    const rows = Math.ceil(totalMeasures / MPR);
    const rowPedalY = new Array(rows).fill(null);

    const rowNeedsPedal = new Array(rows).fill(false);
    scoreData.pedalMarkings.forEach(pm => {
      const startMeasure = Math.floor(pm.startBeat / beatsPerMeasure);
      const endMeasure   = Math.min(Math.floor(pm.endBeat / beatsPerMeasure), totalMeasures - 1);
      for (let m = startMeasure; m <= endMeasure; m++) {
        rowNeedsPedal[Math.floor(m / MPR)] = true;
      }
    });

    for (let row = 0; row < rows; row++) {
      if (!rowNeedsPedal[row]) continue;
      const rowY  = row * this._rowHeight() + ScoreRenderer.MARGIN_Y;
      const bassY = rowY + ScoreRenderer.TREBLE_Y_OFF + 40 + ScoreRenderer.STAVE_GAP;
      const bassStaveBottom = bassY + 40;
      const rowYMax = rowY + this._rowHeight();

      const rowXStart = ScoreRenderer.MARGIN_X;
      const rowXEnd   = ScoreRenderer.MARGIN_X + ScoreRenderer.FIRST_EXTRA
        + (MPR - 1) * ScoreRenderer.STAVE_W + ScoreRenderer.STAVE_W;

      const lowestY = this._getColumnLowestY(svg, rowXStart, rowXEnd, bassY - 5, rowYMax, bassStaveBottom);
      rowPedalY[row] = Math.max(lowestY + MIN_CLEARANCE, bassStaveBottom + MIN_CLEARANCE);
    }

    // ── Passe 2 : dessiner "Ped." / "*" alignés sur la position de leur ligne ──
    scoreData.pedalMarkings.forEach(pm => {
      const startMeasure = Math.floor(pm.startBeat / beatsPerMeasure);
      const endMeasure   = Math.min(Math.floor(pm.endBeat / beatsPerMeasure), totalMeasures - 1);
      const startBeatInM = pm.startBeat % beatsPerMeasure;
      const endBeatInM   = pm.endBeat % beatsPerMeasure;

      for (let m = startMeasure; m <= endMeasure; m++) {
        const row  = Math.floor(m / MPR);
        const col  = m % MPR;
        const isFirstRow = col === 0;
        const pedLineY = rowPedalY[row];
        if (pedLineY == null) continue;

        const staveX = isFirstRow
          ? ScoreRenderer.MARGIN_X
          : ScoreRenderer.MARGIN_X + ScoreRenderer.FIRST_EXTRA + col * ScoreRenderer.STAVE_W;
        const staveW = isFirstRow
          ? ScoreRenderer.STAVE_W + ScoreRenderer.FIRST_EXTRA
          : ScoreRenderer.STAVE_W;

        const noteStartX = staveX + (isFirstRow ? ScoreRenderer.FIRST_EXTRA : 20);
        const noteEndX   = staveX + staveW - 8;
        const noteWidth  = noteEndX - noteStartX;

        const xStart = m === startMeasure ? noteStartX + (startBeatInM / beatsPerMeasure) * noteWidth : noteStartX;
        let   xEnd   = m === endMeasure   ? noteStartX + (endBeatInM   / beatsPerMeasure) * noteWidth : noteEndX;
        if (m === endMeasure && xEnd <= xStart + 5) xEnd = noteEndX;

        // Symbole "Ped." au début de la tenue
        if (m === startMeasure) {
          const pedText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          pedText.setAttribute('x', xStart);
          pedText.setAttribute('y', pedLineY);
          pedText.setAttribute('font-family', 'serif');
          pedText.setAttribute('font-size', '13');
          pedText.setAttribute('font-style', 'italic');
          pedText.setAttribute('fill', '#444');
          pedText.setAttribute('class', 'pedal-symbol');
          pedText.textContent = 'Ped.';
          svg.appendChild(pedText);
        }

        // Symbole "*" à la fin de la tenue
        if (m === endMeasure) {
          const relText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          relText.setAttribute('x', xEnd);
          relText.setAttribute('y', pedLineY);
          relText.setAttribute('font-family', 'serif');
          relText.setAttribute('font-size', '15');
          relText.setAttribute('font-weight', 'bold');
          relText.setAttribute('fill', '#444');
          relText.setAttribute('class', 'pedal-release');
          relText.setAttribute('text-anchor', 'middle');
          relText.textContent = '*';
          svg.appendChild(relText);
        }
      }
    });
  }

  /**
   * Renvoie la coordonnée Y (SVG) la plus basse parmi les éléments déjà
   * dessinés dont la bounding box intersecte horizontalement [x0, x1] et se
   * situe sous yMin (zone de la portée de basse et en dessous). Retombe sur
   * `fallback` si aucun élément pertinent n'est trouvé ou en cas d'erreur
   * (ex: getBBox indisponible en environnement de test).
   */
  /**
   * Renvoie la coordonnée Y (SVG) la plus basse parmi les éléments déjà
   * dessinés dont la bounding box intersecte horizontalement [x0, x1] et se
   * situe entre yMin et yMax (bande verticale de la rangée courante
   * uniquement — cf. bug corrigé v4.2 ci-dessus). Retombe sur `fallback` si
   * aucun élément pertinent n'est trouvé ou en cas d'erreur (ex: getBBox
   * indisponible en environnement de test).
   */
  _getColumnLowestY(svg, x0, x1, yMin, yMax, fallback) {
    let lowest = fallback;
    try {
      const candidates = svg.querySelectorAll('path, text, g, ellipse, rect');
      candidates.forEach(el => {
        if (el.closest && el.closest('.pedal-symbol, .pedal-release')) return;
        let bbox;
        try { bbox = el.getBBox(); } catch (e) { return; }
        if (!bbox || (bbox.width === 0 && bbox.height === 0)) return;
        const cx = bbox.x + bbox.width / 2;
        if (cx < x0 || cx > x1) return;
        if (bbox.y < yMin || bbox.y > yMax) return; // hors de la bande de cette rangée
        const bottom = bbox.y + bbox.height;
        if (bottom > lowest) lowest = bottom;
      });
    } catch (e) {
      return fallback;
    }
    return lowest;
  }
}


/* ── Exposition globale pour le slider de tempo V2 ─────────────────────── */
/**
 * window.rerenderScore(scoreData)
 * Déclenche un re-rendu de la partition avec un scoreData mis à jour (ex: tempo modifié).
 * Réutilise l'instance renderer existante (pas de recréation de la classe).
 * Appelée par le slider de tempo post-transcription (Phase 5).
 */
window.rerenderScore = function (scoreData) {
  if (typeof renderer !== 'undefined' && renderer && typeof renderer.render === 'function') {
    renderer.render(scoreData);
  }
};
