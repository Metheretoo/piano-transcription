/**
 * editor.js — Éditeur interactif de partition
 *
 * Responsabilités :
 *  - Maintenir le modèle de données (scoreData)
 *  - Gérer la sélection de notes
 *  - Opérations : transposer, changer durée, changer de main, supprimer
 *  - Historique undo/redo
 *  - Synchroniser le renderer et le panneau de propriétés
 */

'use strict';

/* ── Utilitaires musicaux ────────────────────────────────────────────────── */

const PITCH_NAMES_FR = [
  'Do','Do♯','Ré','Ré♯','Mi','Fa','Fa♯','Sol','Sol♯','La','La♯','Si'
];

const PITCH_NAMES_VF_SHARP = [
  'c','c#','d','d#','e','f','f#','g','g#','a','a#','b'
];
const PITCH_NAMES_VF_FLAT = [
  'c','db','d','eb','e','f','gb','g','ab','a','bb','b'
];

const FLAT_KEY_SIGS = new Set(['F','Bb','Eb','Ab','Db','Gb','Cb']);

const DUR_TO_BEATS = {
  w: 4.0, h: 2.0, q: 1.0, '8': 0.5, '16': 0.25,
};

const DUR_NAMES_FR = {
  w: 'Ronde', h: 'Blanche', q: 'Noire', '8': 'Croche', '16': 'Double croche',
};

function midiToVexflowKey(pitch, keySig = 'C') {
  const names = FLAT_KEY_SIGS.has(keySig) ? PITCH_NAMES_VF_FLAT : PITCH_NAMES_VF_SHARP;
  const name   = names[pitch % 12];
  const octave = Math.floor(pitch / 12) - 1;
  return `${name}/${octave}`;
}

function midiToNoteName(pitch) {
  if (pitch === null || pitch === undefined) return '—';
  const name   = PITCH_NAMES_FR[pitch % 12];
  const octave = Math.floor(pitch / 12) - 1;
  return `${name} ${octave}`;
}

function durationName(dur, dots) {
  const base = DUR_NAMES_FR[dur] || dur;
  return dots ? base + ' pointée' : base;
}

function vexflowKeyToMidi(key) {
  const NOTE_ST = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  const parts = key.split('/');
  if (parts.length < 2) return 60;
  const noteStr = parts[0].toLowerCase();
  const octave  = parseInt(parts[1], 10);
  const baseLetter = noteStr[0];          // 'a', 'b', 'c', …
  const base        = NOTE_ST[baseLetter] ?? 0;
  // Accidentals start AFTER the first letter — so 'bb' (Bb) has 1 flat, 'b#' has 1 sharp
  const accidentals = noteStr.slice(1);
  const sharps = (accidentals.match(/#/g) || []).length;
  const flats  = (accidentals.match(/b/g) || []).length;
  const mod    = sharps - flats;
  return (octave + 1) * 12 + base + mod;
}

function generateId() {
  return '_' + Math.random().toString(36).slice(2, 11);
}

/**
 * Retourne la clé VexFlow correcte pour un silence.
 * Positions standard VexFlow : ronde accrochée depuis d/5 (treble) / f/3 (bass).
 */
function getRestKey(durStr, hand, dots = 0) {
  if (hand === 'treble') {
    return durStr === 'w' ? 'd/5' : 'b/4';
  } else {
    return durStr === 'w' ? 'f/3' : 'd/3';
  }
}

/* ── Classe ScoreEditor ──────────────────────────────────────────────────── */

class ScoreEditor {
  constructor(renderer) {
    this.renderer        = renderer;
    this.scoreData       = null;
    this.selectedNoteId  = null;
    this.selectedNoteIds = []; // Liste des IDs de notes multi-sélectionnées
    this.selectedKeyIdx  = 0;  // Index de la note spécifique sélectionnée dans l'accord
    this.history         = []; // snapshots JSON
    this.historyIdx      = -1;
    this.MAX_HISTORY     = 30;

    /* Callback de clic sur une note depuis le renderer */
    renderer.onNoteClick((noteId, noteInfo, keyIdx, event) => {
      this._select(noteId, noteInfo ? noteInfo.noteData : null, keyIdx, event);
    });
  }

  /* ── Chargement d'une partition ────────────────────────────────────── */
  loadScore(scoreData) {
    this.scoreData       = this._clone(scoreData);
    this._sanitizeRests();
    this.selectedNoteId  = null;
    this.selectedNoteIds = [];
    this.selectedKeyIdx  = 0;
    this.history         = [];
    this.historyIdx      = -1;
    this._render();
    this._updateMeta();
    this._updatePropsPanel(null);
    this._updateUndoRedo();
  }

  getScoreData() { return this.scoreData; }

  /* ── Sélection ─────────────────────────────────────────────────────── */
  _select(noteId, noteData, keyIdx, event) {
    if (!noteId) {
      this.clearSelection();
      return;
    }

    const isCtrl = event && (event.ctrlKey || event.metaKey);

    if (isCtrl) {
      // Mode sélection multiple (Ctrl)
      if (!this.selectedNoteIds.includes(noteId)) {
        this.selectedNoteIds.push(noteId);
      } else {
        // Déjà dedans -> l'enlever
        this.selectedNoteIds = this.selectedNoteIds.filter(id => id !== noteId);
      }
      // On choisit la première sélectionnée comme note principale pour le panneau
      this.selectedNoteId = this.selectedNoteIds[0] || null;
      this.selectedKeyIdx = 0;
    } else {
      // Sélection simple classique
      this.selectedNoteId = noteId;
      this.selectedNoteIds = [noteId];
      this.selectedKeyIdx = keyIdx ?? 0;
    }

    this.renderer.highlightNote(this.selectedNoteIds, this.selectedKeyIdx);
    this._updatePropsPanel(this.selectedNoteIds.length > 1 ? { isMulti: true, count: this.selectedNoteIds.length } : noteData);
  }

  clearSelection() {
    this.selectedNoteId = null;
    this.selectedNoteIds = [];
    this.selectedKeyIdx = 0;
    this.renderer.clearHighlight();
    this._updatePropsPanel(null);
  }

  /* ── Opérations sur la note sélectionnée ───────────────────────────── */

  /** Transpose la note de `semitones` demi-tons. */
  transposeSelected(semitones) {
    const found = this._findSelected();
    if (!found || found.note.isRest) return;

    this._pushHistory();

    const note = found.note;
    const keyIdx = this.selectedKeyIdx ?? 0;
    const keySig = this.scoreData.keySignature || 'C';

    // Transposer uniquement la note spécifique de l'accord sélectionnée par l'utilisateur
    if (note.keys && note.keys.length > keyIdx) {
      const targetKey = note.keys[keyIdx];
      const pitch = vexflowKeyToMidi(targetKey);
      const newPitch = Math.max(21, Math.min(108, pitch + semitones));
      note.keys[keyIdx] = midiToVexflowKey(newPitch, keySig);

      // Si on modifie le premier ou unique pitch, on synchronise le midiPitch principal
      if (keyIdx === 0) {
        note.midiPitch = newPitch;
      }
    }

    this._render();
    this._afterEdit(note);
  }

  /**
   * Toggle l'enharmonie de la note sélectionnée.
   * Ex: Sol# ↔ La♭, Fa# ↔ Sol♭, Do# ↔ Ré♭, etc.
   * Conserve le même MIDI pitch mais change le nom de note.
   */
  toggleEnharmonic() {
    const found = this._findSelected();
    if (!found || found.note.isRest) return;

    this._pushHistory();

    const note = found.note;
    const keyIdx = this.selectedKeyIdx ?? 0;
    const keySig = this.scoreData.keySignature || 'C';

    if (note.keys && note.keys.length > keyIdx) {
      const targetKey = note.keys[keyIdx];
      const pitch = vexflowKeyToMidi(targetKey);

      // Mapping enharmonique : pour chaque pitch, donner l'alternative
      const enharmonicMap = {
        'c#': 'db', 'db': 'c#',
        'd#': 'eb', 'eb': 'd#',
        'f#': 'gb', 'gb': 'f#',
        'g#': 'ab', 'ab': 'g#',
        'a#': 'bb', 'bb': 'a#',
      };

      // Extraire le nom de note (sans l'octave)
      const match = targetKey.match(/^([a-gA-G][#b]?)/i);
      if (!match) return;

      const noteName = match[1].toLowerCase();
      const altName = enharmonicMap[noteName];

      if (!altName) {
        // Pas d'enharmonie disponible (notes sans altération)
        return;
      }

      // Extraire l'octave depuis le format VexFlow: "nom/octave" ou "nom/octave:alt"
      const parts = targetKey.split('/');
      const octavePart = parts.length >= 2 ? parts[1].split(':')[0] : '4';

      // Déterminer si la note originale avait une altération explicite
      const hadAccidental = noteName.includes('#') || noteName.includes('b');

      if (hadAccidental) {
        // La note avait une altération → on reconstruit avec l'altération correcte
        // Le nom enharmonique (ex: 'ab') porte déjà son bémol natif, donc pas besoin de ':b'
        // Mais si le nom n'a pas d'altération native (ex: 'c#'), on ajoute ':#'
        const hasNativeAccidental = altName.includes('#') || altName.includes('b');
        if (hasNativeAccidental) {
          note.keys[keyIdx] = `${altName}/${octavePart}`;
        } else {
          note.keys[keyIdx] = `${altName}/${octavePart}:#`;
        }
      } else {
        // La note n'avait PAS d'altération (bécarre) → on ajoute ':n' (bécarre explicite)
        note.keys[keyIdx] = `${altName}/${octavePart}:n`;
      }

      // Synchroniser le midiPitch principal si c'est la première note
      if (keyIdx === 0) {
        note.midiPitch = pitch; // Le pitch MIDI ne change pas !
      }
    }

    this._render();
    this._afterEdit(note);
  }

  /** Change la durée de la note, en ajustant les silences adjacents pour maintenir la cohérence. */
  setDurationSelected(durStr) {
    const found = this._findSelected();
    if (!found) return;

    this._pushHistory();

    const note    = found.note;
    const hand    = found.hand;
    const oldDur  = note.duration;
    const newDur  = DUR_TO_BEATS[durStr] ?? 1.0;
    const delta   = Math.round((newDur - oldDur) * 1000) / 1000;

    note.durationStr = durStr;
    note.dots        = 0;
    note.duration    = newDur;

    if (note.isRest) {
      note.keys = [getRestKey(durStr, hand, 0)];
    }

    // --- Ajuster les silences voisins DANS LA MESURE LOCALE ---
    const voiceArr = found.voiceArr;
    const noteIdx = found.idx;

    if (Math.abs(delta) > 0.005) {
      const [num, den] = this.scoreData.timeSignature || [4, 4];
      const beatsPerMeasure = num * (4.0 / den);
      
      if (delta < 0) {
        // La note a RACCOURCI : insérer un silence SEULEMENT si la mesure n'est pas déjà en dépassement
        let newMeasureDur = 0;
        voiceArr.forEach(n => newMeasureDur += n.duration);
        
        if (newMeasureDur < beatsPerMeasure) {
          const amountToPad = Math.min(-delta, beatsPerMeasure - newMeasureDur);
          const gapStart = note.startBeat + newDur;
          const newRests = this._makeRestsForDuration(gapStart, amountToPad, hand);
          voiceArr.splice(noteIdx + 1, 0, ...newRests);
        }
      } else {
        // La note a GRANDI : absorber les silences suivants (jamais une note, et sans déborder sur la mesure suivante)
        let toAbsorb = delta;
        let nextIdx = noteIdx + 1;
        while (toAbsorb > 0.005 && nextIdx < voiceArr.length) {
          const next = voiceArr[nextIdx];
          if (!next.isRest) {
            break; // Impossible d'absorber une vraie note
          }
          const restDur = next.duration;
          if (restDur <= toAbsorb + 0.005) {
            // Absorber ce silence entièrement
            voiceArr.splice(nextIdx, 1);
            toAbsorb = Math.round((toAbsorb - restDur) * 1000) / 1000;
          } else {
            // Réduire ce silence du delta restant
            next.duration  = Math.round((restDur - toAbsorb) * 1000) / 1000;
            // Mettre à jour durationStr / dots du silence réduit
            const DUR_MAP = {
              4.0: ['w', 0], 3.0: ['h', 1], 2.0: ['h', 0],
              1.5: ['q', 1], 1.0: ['q', 0], 0.75: ['8', 1],
              0.5: ['8', 0], 0.375: ['16', 1], 0.25: ['16', 0],
            };
            const [ds, dt] = DUR_MAP[next.duration] || [next.durationStr, next.dots];
            next.durationStr = ds; next.dots = dt;
            next.keys = [getRestKey(ds, hand, dt)];
            toAbsorb = 0;
          }
        }
      }

      // Reconstruire les startBeat STRICTEMENT LOCAUX à cette mesure
      const mIdx = this.scoreData.measures.indexOf(found.measure);
      let cur = Math.round(mIdx * beatsPerMeasure * 1000) / 1000;
      voiceArr.forEach(n => { 
        n.startBeat = Math.round(cur * 1000) / 1000; 
        cur += n.duration; 
      });
    }

    this._render();
    this._afterEdit(note);
  }

  /** Ajoute ou enlève un point à la note. */
  toggleDotSelected() {
    const found = this._findSelected();
    if (!found) return;

    this._pushHistory();

    const note = found.note;
    const oldDur = note.duration;

    if (note.dots) {
      note.dots = 0;
      note.duration = DUR_TO_BEATS[note.durationStr] ?? 1.0;
    } else {
      note.dots = 1;
      note.duration = (DUR_TO_BEATS[note.durationStr] ?? 1.0) * 1.5;
    }

    if (note.isRest) {
      note.keys = [getRestKey(note.durationStr, found.hand, note.dots)];
    }

    // Reconstruire les startBeat STRICTEMENT LOCAUX à cette mesure
    const voiceArr = found.voiceArr;
    const [num, den] = this.scoreData.timeSignature || [4, 4];
    const beatsPerMeasure = num * (4.0 / den);
    const mIdx = this.scoreData.measures.indexOf(found.measure);
    
    let cur = Math.round(mIdx * beatsPerMeasure * 1000) / 1000;
    voiceArr.forEach(n => { 
      n.startBeat = Math.round(cur * 1000) / 1000; 
      cur += n.duration; 
    });

    this._render();
    this._afterEdit(note);
  }

  /** Assigne la note ou le silence à une main (treble | bass). */
  assignHandSelected(hand) {
    const found = this._findSelected();
    if (!found || found.hand === hand) return;

    // 1. Identifier la note à déplacer
    const note = found.note;
    const keyIdx = this.selectedKeyIdx ?? 0;
    const extractedKey = note.keys[keyIdx];
    const pitchMidi = note.isRest ? null : vexflowKeyToMidi(extractedKey);

    const srcBeat = note.startBeat;
    const srcDur = note.duration;

    // 2. Analyser la cible
    const flatDst = this._getFlatVoice(hand);
    
    // Trouver l'élément qui occupe le startBeat dans la main de destination
    let targetElementIdx = flatDst.findIndex(n => 
        n.startBeat <= srcBeat + 0.005 && 
        (n.startBeat + n.duration) > srcBeat + 0.005
    );

    if (targetElementIdx === -1) {
        if (typeof showToast === 'function') showToast('⚠️ Erreur : structure temporelle cible introuvable.', 'error');
        return;
    }

    const targetEl = flatDst[targetElementIdx];
    const isExactStart = Math.abs(targetEl.startBeat - srcBeat) < 0.005;

    let destinationNote = null;

    this._pushHistory();

    // 3. Retirer de la source (laissant un silence si note seule)
    const flatSrc = this._getFlatVoice(found.hand);
    if (!note.isRest && note.keys.length > 1) {
        // Accord : retirer uniquement le pitch
        note.keys.splice(keyIdx, 1);
        if (keyIdx === 0) note.midiPitch = vexflowKeyToMidi(note.keys[0]);
    } else {
        // Note seule : remplacer par un silence
        const srcIdx = flatSrc.findIndex(n => n.id === note.id);
        if (srcIdx !== -1) {
            flatSrc[srcIdx] = this._makeRest(note, found.hand);
        }
    }

    // 4. Insérer dans la destination
    if (!targetEl.isRest) {
        // Fusionner dans l'accord existant (la note prend la durée de la cible)
        if (!note.isRest && !targetEl.keys.includes(extractedKey)) {
            targetEl.keys.push(extractedKey);
            targetEl.keys.sort((a, b) => vexflowKeyToMidi(a) - vexflowKeyToMidi(b));
        }
        destinationNote = targetEl;
    } else if (targetEl.isRest) {
        // La cible est un silence : on le scinde et on insère, en tronquant si nécessaire
        let insertDur = srcDur;
        const availableDur = (targetEl.startBeat + targetEl.duration) - srcBeat;
        if (insertDur > availableDur + 0.005) {
            insertDur = availableDur; // Troncature chirurgicale
        }

        const newNote = {
            id: generateId(),
            keys: [note.isRest ? getRestKey(note.durationStr, hand, note.dots) : extractedKey],
            durationStr: note.durationStr,
            dots: note.dots,
            isRest: note.isRest,
            startBeat: srcBeat,
            duration: insertDur,
            midiPitch: pitchMidi,
            hand: hand,
            amplitude: note.amplitude ?? 0.7,
        };

        // Recalculer durationStr et dots si la note a été tronquée
        if (Math.abs(insertDur - srcDur) > 0.005) {
            const DUR_MAP = {
                4.0: ['w', 0], 3.0: ['h', 1], 2.0: ['h', 0],
                1.5: ['q', 1], 1.0: ['q', 0], 0.75: ['8', 1],
                0.5: ['8', 0], 0.375: ['16', 1], 0.25: ['16', 0],
            };
            const closestDur = Object.keys(DUR_MAP).reduce((a, b) => Math.abs(b - insertDur) < Math.abs(a - insertDur) ? b : a);
            if (Math.abs(parseFloat(closestDur) - insertDur) < 0.05) {
                newNote.durationStr = DUR_MAP[closestDur][0];
                newNote.dots = DUR_MAP[closestDur][1];
                newNote.duration = parseFloat(closestDur);
                if (newNote.isRest) newNote.keys = [getRestKey(newNote.durationStr, hand, newNote.dots)];
            }
        }

        const toInsert = [];
        const preDur = Math.round((srcBeat - targetEl.startBeat) * 1000) / 1000;
        if (preDur > 0.005) {
            toInsert.push(...this._makeRestsForDuration(targetEl.startBeat, preDur, hand));
        }
        
        toInsert.push(newNote);
        
        const postStart = newNote.startBeat + newNote.duration;
        const postDur = Math.round((targetEl.startBeat + targetEl.duration - postStart) * 1000) / 1000;
        if (postDur > 0.005) {
            toInsert.push(...this._makeRestsForDuration(postStart, postDur, hand));
        }

        flatDst.splice(targetElementIdx, 1, ...toInsert);
        destinationNote = newNote;
    }

    // 5. Reconstruire UNIQUEMENT les tableaux de mesures (sans recalculer les startBeat globaux)
    const flatTreble = hand === 'treble' ? flatDst : flatSrc;
    const flatBass   = hand === 'bass'   ? flatDst : flatSrc;
    
    const [num, den] = this.scoreData.timeSignature || [4, 4];
    const beatsPerMeasure = num * (4.0 / den);
    
    const newMeasures = [];
    for (let i = 0; i < this.scoreData.totalMeasures; i++) {
        newMeasures.push({ treble: [], bass: [] });
    }

    flatTreble.forEach(n => {
        const mIdx = Math.floor((n.startBeat + 0.005) / beatsPerMeasure);
        if (mIdx >= 0 && mIdx < newMeasures.length) newMeasures[mIdx].treble.push(n);
    });
    flatBass.forEach(n => {
        const mIdx = Math.floor((n.startBeat + 0.005) / beatsPerMeasure);
        if (mIdx >= 0 && mIdx < newMeasures.length) newMeasures[mIdx].bass.push(n);
    });

    this.scoreData.measures = newMeasures;

    // 6. Restaurer la sélection
    if (destinationNote) {
        this.selectedNoteId = destinationNote.id;
        this.selectedNoteIds = [destinationNote.id];
        this.selectedKeyIdx = destinationNote.keys.indexOf(extractedKey);
        if (this.selectedKeyIdx === -1) this.selectedKeyIdx = 0;
    } else {
        this.clearSelection();
    }

    this._render();
    this._afterEdit(destinationNote);
  }

  deleteSelected() {
    const found = this._findSelected();
    if (!found) return;

    this._pushHistory();

    const note   = found.note;
    const keyIdx = this.selectedKeyIdx ?? 0;

    if (note.keys && note.keys.length > 1) {
      // Accord multi-notes → retirer uniquement le notehead cliqué
      note.keys.splice(keyIdx, 1);
      this.selectedKeyIdx = 0;
      this._render();
      this._afterEdit(note);
    } else {
      // Note ou Silence seul → supprimer ou remplacer par un silence pour respecter la métrique
      const [num, den] = this.scoreData.timeSignature || [4, 4];
      const beatsPerMeasure = num * (4.0 / den);
      
      const mIdx = Math.floor(note.startBeat / beatsPerMeasure);
      let currentMeasureDur = 0;
      (found.measure[found.hand] || []).forEach(n => currentMeasureDur += n.duration);
      
      const newMeasureDur = currentMeasureDur - note.duration;
      
      if (newMeasureDur < beatsPerMeasure) {
        if (note.isRest && Math.abs(currentMeasureDur - beatsPerMeasure) < 0.005) {
           // Si c'est déjà un silence et que la mesure est parfaite (ou sous-pleine), on refuse !
           if (typeof showToast === 'function') showToast('⚠️ Impossible de supprimer ce silence. Il maintient la synchronisation. Changez plutôt sa durée.', 'warning');
           this._abortEdit();
           return;
        }
        const amountToPad = Math.min(note.duration, beatsPerMeasure - newMeasureDur);
        const newRests = this._makeRestsForDuration(note.startBeat, amountToPad, found.hand);
        found.voiceArr.splice(found.idx, 1, ...newRests);
      } else {
        // La mesure débordait tellement qu'on peut supprimer sans compenser
        found.voiceArr.splice(found.idx, 1);
      }
      
      // Reconstruire les startBeat STRICTEMENT LOCAUX à cette mesure
      const mIdxMeasure = this.scoreData.measures.indexOf(found.measure);
      let cur = Math.round(mIdxMeasure * beatsPerMeasure * 1000) / 1000;
      found.voiceArr.forEach(n => { 
        n.startBeat = Math.round(cur * 1000) / 1000; 
        cur += n.duration; 
      });
      
      this.selectedNoteId = null;
      this.selectedKeyIdx = 0;
      this._render();
      this._updatePropsPanel(null);
      this._updateUndoRedo();
      if (typeof showToast === 'function') showToast('🗑 Élément supprimé.', 'success');
    }
  }

  /* ── Undo / Redo ───────────────────────────────────────────────────── */
  undo() {
    if (this.historyIdx < 0) return;
    this.scoreData  = this._clone(this.history[this.historyIdx]);
    this.historyIdx--;
    this.selectedNoteId = null;
    this._render();
    this._updateMeta();
    this._updatePropsPanel(null);
    this._updateUndoRedo();
  }

  _abortEdit() {
    if (this.historyIdx < 0) return;
    this.scoreData = this._clone(this.history[this.historyIdx]);
    this.history.pop();
    this.historyIdx--;
    this._render();
    const found = this._findSelected();
    this._updatePropsPanel(found ? found.note : null);
  }

  redo() {
    if (this.historyIdx >= this.history.length - 1) return;
    this.historyIdx++;
    this.scoreData = this._clone(this.history[this.historyIdx]);
    this._render();
    this._updateMeta();
    this._updatePropsPanel(null);
    this._updateUndoRedo();
  }

  /* ── Interne ────────────────────────────────────────────────────────── */
  _sanitizeRests() {
    if (!this.scoreData || !this.scoreData.measures) return;
    this.scoreData.measures.forEach(measure => {
      ['treble', 'bass'].forEach(hand => {
        (measure[hand] || []).forEach(note => {
          if (note.isRest) {
            note.keys = [getRestKey(note.durationStr, hand, note.dots)];
          }
        });
      });
    });
  }

  _render() {
    this.renderer.render(this.scoreData);
    if (this.selectedNoteIds && this.selectedNoteIds.length > 0) {
      this.renderer.highlightNote(this.selectedNoteIds, this.selectedKeyIdx);
    } else if (this.selectedNoteId) {
      this.renderer.highlightNote(this.selectedNoteId, this.selectedKeyIdx);
    }
    // ✅ Rendre les noms de notes les plus hautes après chaque édition
    if (this.renderer.showHighestNote && typeof this.renderer.renderHighestNoteLabels === 'function') {
      this.renderer.renderHighestNoteLabels();
    }
  }

  _afterEdit(note) {
    this._updatePropsPanel(note);
    this._updateUndoRedo();
  }

  _pushHistory() {
    /* Tronquer la branche redo */
    this.history = this.history.slice(0, this.historyIdx + 1);
    this.history.push(this._clone(this.scoreData));
    if (this.history.length > this.MAX_HISTORY) this.history.shift();
    this.historyIdx = this.history.length - 1;
  }

  _clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  /** Trouve une note par son id dans scoreData. */
  _findById(noteId) {
    if (!noteId || !this.scoreData) return null;
    for (const measure of this.scoreData.measures) {
      for (const hand of ['treble', 'bass']) {
        const arr = measure[hand] || [];
        const idx = arr.findIndex(n => n.id === noteId);
        if (idx !== -1) {
          return { note: arr[idx], hand, measure, voiceArr: arr, idx };
        }
      }
    }
    return null;
  }

  /** Trouve la note sélectionnée dans scoreData. */
  _findSelected() {
    return this._findById(this.selectedNoteId);
  }

  _makeRest(note, hand) {
    const restKey = getRestKey(note.durationStr, hand, note.dots);
    return {
      id:          generateId(),
      keys:        [restKey],
      durationStr: note.durationStr,
      dots:        note.dots,
      isRest:      true,
      startBeat:   note.startBeat,
      duration:    note.duration,
      midiPitch:   null,
      hand:        hand,
      amplitude:   0,
    };
  }

  /**
   * Crée une série de silences pour couvrir totalDuration beats à partir de startBeat.
   * Utilise les valeurs musicales standards (ronde, blanche pointée, blanche…).
   */
  _makeRestsForDuration(startBeat, totalDuration, hand) {
    const rests = [];
    const DUR_MAP = {
      4.0: ['w', 0], 3.0: ['h', 1], 2.0: ['h', 0],
      1.5: ['q', 1], 1.0: ['q', 0], 0.75: ['8', 1],
      0.5: ['8', 0], 0.375: ['16', 1], 0.25: ['16', 0],
    };
    const REST_DURS = [4.0, 3.0, 2.0, 1.5, 1.0, 0.75, 0.5, 0.375, 0.25];
    let remaining = Math.round(totalDuration * 1000) / 1000;
    let pos = startBeat;
    while (remaining > 0.005) {
      let chosen = REST_DURS.find(d => d <= remaining + 0.005);
      if (!chosen) chosen = 0.25;
      chosen = Math.round(chosen * 1000) / 1000;
      const [durStr, dots] = DUR_MAP[chosen] || ['16', 0];
      rests.push({
        id:          generateId(),
        keys:        [getRestKey(durStr, hand, dots)],
        durationStr: durStr,
        dots,
        isRest:      true,
        startBeat:   pos,
        duration:    chosen,
        midiPitch:   null,
        hand,
        amplitude:   0,
      });
      remaining = Math.round((remaining - chosen) * 1000) / 1000;
      pos += chosen;
    }
    return rests;
  }

  /**
   * Cherche dans voiceArr le silence qui contient entièrement la plage
   * [targetBeat, targetBeat + noteDuration].
   */
  _findContainingRest(voiceArr, targetBeat, noteDuration) {
    return voiceArr.findIndex(n =>
      n.isRest &&
      n.startBeat <= targetBeat + 0.005 &&
      (n.startBeat + n.duration) >= (targetBeat + noteDuration) - 0.005
    );
  }

  /**
   * Insère newNote dans targetVoice au bon endroit.
   * 1. Remplacement exact si un silence de même startBeat + durée existe.
   * 2. Découpage du silence englobant si la note y tient.
   * 3. Fallback : push + sort (cas désynchronisé).
   */
  _insertNoteIntoVoice(targetVoice, newNote, hand) {
    // 0. Exact startBeat match with an existing note (merge into chord)
    const existingIdx = targetVoice.findIndex(n =>
      !n.isRest &&
      Math.abs(n.startBeat - newNote.startBeat) < 0.005
    );

    if (existingIdx !== -1) {
      const existing = targetVoice[existingIdx];
      // Force new note's duration to match the existing one to not break the timeline
      newNote.duration = existing.duration;
      newNote.durationStr = existing.durationStr;
      newNote.dots = existing.dots;
      
      if (!newNote.isRest) {
        newNote.keys.forEach(k => {
          if (!existing.keys.includes(k)) {
            existing.keys.push(k);
          }
        });
        existing.keys.sort((a, b) => vexflowKeyToMidi(a) - vexflowKeyToMidi(b));
      }
      return true; // Merged, no new note added
    }

    // 1. Exact match with a rest
    const exactIdx = targetVoice.findIndex(n =>
      n.isRest &&
      Math.abs(n.startBeat - newNote.startBeat) < 0.005 &&
      Math.abs(n.duration  - newNote.duration)  < 0.005
    );
    if (exactIdx !== -1) {
      targetVoice[exactIdx] = newNote;
      return true;
    }

    const [num, den] = this.scoreData.timeSignature || [4, 4];
    const beatsPerMeasure = num * (4.0 / den);
    const measureEnd = (Math.floor(newNote.startBeat / beatsPerMeasure) + 1) * beatsPerMeasure;

    if (newNote.startBeat + newNote.duration > measureEnd + 0.005) {
      if (typeof showToast === 'function') showToast('⚠️ Espace insuffisant : déborde sur la mesure suivante.', 'error');
      return false;
    }

    // 2. Silence englobant → découpage
    const containIdx = this._findContainingRest(targetVoice, newNote.startBeat, newNote.duration);
    if (containIdx !== -1) {
      const rest = targetVoice[containIdx];
      const toInsert = [];

      const preDur = Math.round((newNote.startBeat - rest.startBeat) * 1000) / 1000;
      if (preDur > 0.005) {
        toInsert.push(...this._makeRestsForDuration(rest.startBeat, preDur, hand));
      }

      toInsert.push(newNote);

      const postStart = newNote.startBeat + newNote.duration;
      const postDur   = Math.round((rest.startBeat + rest.duration - postStart) * 1000) / 1000;
      if (postDur > 0.005) {
        toInsert.push(...this._makeRestsForDuration(postStart, postDur, hand));
      }

      targetVoice.splice(containIdx, 1, ...toInsert);
      return true;
    }

    // 3. Overwrite multiple rests or partial overlap (consume subsequent rests)
    let remainingDur = newNote.duration;
    let pos = newNote.startBeat;
    const restsToRemove = [];
    
    let idx = targetVoice.findIndex(n => Math.abs(n.startBeat - pos) < 0.005);
    let canConsume = true;
    let consumedDur = 0;
    
    if (idx !== -1) {
      let tempIdx = idx;
      while (tempIdx < targetVoice.length && consumedDur < remainingDur - 0.005) {
        const n = targetVoice[tempIdx];
        if (!n.isRest) {
          canConsume = false;
          break; // We hit a note!
        }
        consumedDur += n.duration;
        restsToRemove.push(tempIdx);
        tempIdx++;
      }
    }
    
    if (canConsume && restsToRemove.length > 0) {
      const firstRestIdx = restsToRemove[0];
      const numRests = restsToRemove.length;
      
      const overConsume = Math.round((consumedDur - remainingDur) * 1000) / 1000;
      const toInsert = [newNote];
      if (overConsume > 0.005) {
        const postStart = newNote.startBeat + newNote.duration;
        toInsert.push(...this._makeRestsForDuration(postStart, overConsume, hand));
      }
      
      targetVoice.splice(firstRestIdx, numRests, ...toInsert);
      return true;
    }

    // 4. Fallback : Overlap with another note. We must reject to prevent desync.
    if (typeof showToast === 'function') {
      showToast('⚠️ Espace insuffisant. Réduisez la durée d\'une note ou d\'un silence d\'abord.', 'error');
    }
    return false;
  }

  _updatePropsPanel(noteData) {
    const panel = document.getElementById('properties-panel');
    if (!panel) return;

    if (!noteData) {
      panel.innerHTML = '<p class="no-selection">Cliquez sur une note<br>pour la modifier</p>';
      return;
    }

    if (noteData.isMulti) {
      panel.innerHTML = `
        <div class="prop-row">
          <span class="prop-label">Sélection</span>
          <span class="prop-value" style="color:var(--gold);font-weight:600;">${noteData.count} notes sélectionnées</span>
        </div>
        <div style="margin-top: 15px; display: flex; flex-direction: column; gap: 8px;">
          <button id="btn-group-beams" class="btn btn-primary" style="font-size:11px;padding:6px;width:100%;">
            🔗 Lier les notes
          </button>
          <button id="btn-ungroup-beams" class="btn btn-secondary" style="font-size:11px;padding:6px;width:100%;">
            🔓 Délier les notes
          </button>
          <p style="font-size:10px;color:var(--text-3);line-height:1.3;margin:0;">
            Relie les croches/doubles-croches sélectionnées par une barre de liaison commune (sélection multiple avec Ctrl + Clic).
          </p>
        </div>
      `;
      
      // Attacher les événements du bouton de regroupement/dégroupement
      document.getElementById('btn-group-beams')?.addEventListener('click', () => {
        this.beamSelectedNotes();
      });
      document.getElementById('btn-ungroup-beams')?.addEventListener('click', () => {
        this.unbeamSelectedNotes();
      });
      return;
    }

    if (noteData.isRest) {
      const durName  = durationName(noteData.durationStr, noteData.dots);
      panel.innerHTML = `
        <div class="prop-row">
          <span class="prop-label">Type</span>
          <span class="prop-value note-name">Silence</span>
        </div>
        <div class="prop-row">
          <span class="prop-label">Durée</span>
          <span class="prop-value">${durName}</span>
        </div>
        <div class="prop-row prop-row-hint">
          <span class="prop-label">Actions</span>
          <span class="prop-value" style="font-size:11px;color:var(--text-3)">Changer durée ↑</span>
        </div>
      `;
      return;
    }

    // Récupérer le pitch de la note spécifique sélectionnée dans l'accord
    const keyIdx = this.selectedKeyIdx ?? 0;
    const targetKey = (noteData.keys && noteData.keys.length > keyIdx) ? noteData.keys[keyIdx] : (noteData.keys ? noteData.keys[0] : null);

    let noteName = '—';
    let midiPitch = noteData.midiPitch;
    if (targetKey) {
      midiPitch = vexflowKeyToMidi(targetKey);
      noteName = midiToNoteName(midiPitch);
    }

    const durName  = durationName(noteData.durationStr, noteData.dots);
    const handName = noteData.hand === 'treble' ? '✋ Droite (Sol)' : '🤚 Gauche (Fa)';
    const chordInfo = noteData.keys && noteData.keys.length > 1
      ? `<div class="prop-row">
          <span class="prop-label">Accord</span>
          <span class="prop-value" style="font-size:12px;color:var(--gold)">${noteData.keys.length} notes · Note ${keyIdx + 1}</span>
        </div>`
      : '';

    // Liste des notes de l'accord pour affichage
    const chordNotesList = noteData.keys && noteData.keys.length > 1
      ? `<div class="prop-row" style="flex-direction:column;align-items:flex-start;gap:4px;">
          <span class="prop-label" style="margin-bottom:4px;">Notes accord</span>
          ${noteData.keys.map((k, i) => {
            const m = vexflowKeyToMidi(k);
            const nm = midiToNoteName(m);
            const isSel = i === keyIdx;
            return `<span style="font-size:11px;padding:2px 6px;border-radius:4px;cursor:pointer;
              background:${isSel ? 'var(--purple,#7c3aed)' : 'var(--surface-2,#2a2a3a)'};
              color:${isSel ? '#fff' : 'var(--text-2)'};
              border:1px solid ${isSel ? 'var(--purple,#7c3aed)' : 'transparent'};"
              data-chord-idx="${i}"
              title="Clic pour sélectionner · Suppr pour retirer"
            >${nm}</span>`;
          }).join('')}
        </div>`
      : '';

    panel.innerHTML = `
      ${chordInfo}
      <div class="prop-row">
        <span class="prop-label">Note</span>
        <span class="prop-value note-name">${noteName}</span>
      </div>
      ${chordNotesList}
      <div class="prop-row">
        <span class="prop-label">MIDI #</span>
        <span class="prop-value">${midiPitch}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">Durée</span>
        <span class="prop-value">${durName}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">Main</span>
        <span class="prop-value">${handName}</span>
      </div>
      <div class="prop-row">
        <span class="prop-label">Vélocité</span>
        <span class="prop-value">${Math.round((noteData.amplitude || 0.7) * 127)}</span>
      </div>
      <div style="margin-top:12px;border-top:1px solid var(--panel-border,#333);padding-top:10px;">
        <span class="prop-label" style="display:block;margin-bottom:6px;">✏️ Modifier l'accord</span>
        <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">
          <button id="prop-add-note-up"   class="tool-btn" style="font-size:10px;padding:3px 6px;" title="Ajouter une tierce majeure au-dessus (+4)">+Tierce↑</button>
          <button id="prop-add-note-down" class="tool-btn" style="font-size:10px;padding:3px 6px;" title="Ajouter une quinte juste en-dessous (-7)">+Quinte↓</button>
          <button id="prop-add-octave-up" class="tool-btn" style="font-size:10px;padding:3px 6px;" title="Ajouter octave au-dessus">+8↑</button>
          <button id="prop-add-octave-dn" class="tool-btn" style="font-size:10px;padding:3px 6px;" title="Ajouter octave en-dessous">+8↓</button>
        </div>
        <div style="display:flex;gap:4px;margin-top:5px;">
          <button id="prop-remove-note" class="tool-btn btn-danger" style="font-size:10px;padding:3px 6px;flex:1;" title="Retirer la note sélectionnée de l'accord">🗑 Retirer note ${keyIdx + 1}</button>
        </div>
        <p style="font-size:10px;color:var(--text-3);margin:5px 0 0;">Sélectionne une note de l'accord en cliquant dessus (surlignée en violet).</p>
      </div>
    `;

    // Attacher les événements accord
    panel.querySelectorAll('[data-chord-idx]').forEach(el => {
      el.addEventListener('click', () => {
        const ci = parseInt(el.getAttribute('data-chord-idx'), 10);
        this.selectedKeyIdx = ci;
        this.renderer.highlightNote(this.selectedNoteIds, ci);
        this._updatePropsPanel(noteData);
      });
    });
    panel.querySelector('#prop-add-note-up')?.addEventListener('click', () => {
      this.addNoteToChord(midiPitch + 4);
    });
    panel.querySelector('#prop-add-note-down')?.addEventListener('click', () => {
      this.addNoteToChord(midiPitch - 7);
    });
    panel.querySelector('#prop-add-octave-up')?.addEventListener('click', () => {
      this.addNoteToChord(midiPitch + 12);
    });
    panel.querySelector('#prop-add-octave-dn')?.addEventListener('click', () => {
      this.addNoteToChord(midiPitch - 12);
    });
    panel.querySelector('#prop-remove-note')?.addEventListener('click', () => {
      this.removeNoteFromChord(this.selectedKeyIdx);
    });
  }


  _updateMeta() {
    const panel = document.getElementById('score-meta-panel');
    if (!panel || !this.scoreData) return;

    const { tempo, timeSignature, totalMeasures, keySignature } = this.scoreData;
    const keySigDisplay = keySignature || 'C';
    panel.innerHTML = `
      <div class="meta-row">
        <span class="meta-key">Tempo</span>
        <span class="meta-value">${tempo} BPM</span>
      </div>
      <div class="meta-row">
        <span class="meta-key">Mesure</span>
        <span class="meta-value">${timeSignature[0]}/${timeSignature[1]}</span>
      </div>
      <div class="meta-row">
        <span class="meta-key">Tonalité</span>
        <span class="meta-value">${keySigDisplay}</span>
      </div>
      <div class="meta-row">
        <span class="meta-key">Mesures</span>
        <span class="meta-value">${totalMeasures}</span>
      </div>
    `;
  }

  /** Modifie la tonalité (Key Signature) de la partition. */
  setKeySignature(key) {
    if (!this.scoreData) return;
    this._pushHistory();
    this.scoreData.keySignature = key;
    this._render();
    this._updateMeta();
    const selectedNote = this._findSelected()?.note;
    this._updatePropsPanel(selectedNote || null);
  }

  _updateUndoRedo() {
    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');
    if (undoBtn) undoBtn.disabled = this.historyIdx < 0;
    if (redoBtn) redoBtn.disabled = this.historyIdx >= this.history.length - 1;
  }

  /** Récupère toutes les notes non-silence triées chronologiquement pour la navigation. */
  _getOrderedNotes() {
    if (!this.scoreData) return [];
    const ordered = [];
    this.scoreData.measures.forEach((measure, mIdx) => {
      const mNotes = [];
      ['treble', 'bass'].forEach(hand => {
        (measure[hand] || []).forEach(n => {
          if (!n.isRest) {
            mNotes.push({ note: n, mIdx, hand });
          }
        });
      });
      // Tri par startBeat, puis main droite d'abord, puis pitch descendant
      mNotes.sort((a, b) => {
        if (Math.abs(a.note.startBeat - b.note.startBeat) > 0.01) {
          return a.note.startBeat - b.note.startBeat;
        }
        if (a.hand !== b.hand) {
          return a.hand === 'treble' ? -1 : 1;
        }
        return (b.note.midiPitch || 0) - (a.note.midiPitch || 0);
      });
      ordered.push(...mNotes);
    });
    return ordered;
  }

  /** Sélectionne la note suivante. */
  selectNextNote() {
    const ordered = this._getOrderedNotes();
    if (ordered.length === 0) return;

    if (!this.selectedNoteId) {
      const first = ordered[0];
      this._select(first.note.id, first.note, 0);
      return;
    }

    const idx = ordered.findIndex(item => item.note.id === this.selectedNoteId);
    if (idx !== -1 && idx < ordered.length - 1) {
      const next = ordered[idx + 1];
      this._select(next.note.id, next.note, 0);
    }
  }

  /** Sélectionne la note précédente. */
  selectPrevNote() {
    const ordered = this._getOrderedNotes();
    if (ordered.length === 0) return;

    if (!this.selectedNoteId) {
      const last = ordered[ordered.length - 1];
      this._select(last.note.id, last.note, 0);
      return;
    }

    const idx = ordered.findIndex(item => item.note.id === this.selectedNoteId);
    if (idx > 0) {
      const prev = ordered[idx - 1];
      this._select(prev.note.id, prev.note, 0);
    }
  }

  /** Lie les notes sélectionnées (multi-sélection Ctrl) par une barre de liaison personnalisée. */
  beamSelectedNotes() {
    if (!this.selectedNoteIds || this.selectedNoteIds.length < 2) {
      if (typeof showToast === 'function') {
        showToast('⚠️ Sélectionnez au moins 2 notes (Ctrl + Clic) à lier.', 'error');
      }
      return;
    }

    this._pushHistory();

    if (!this.scoreData.customBeams) {
      this.scoreData.customBeams = {};
    }

    // Créer un ID de groupe de beam unique
    const beamGroupId = 'beam_grp_' + generateId();

    this.selectedNoteIds.forEach(id => {
      this.scoreData.customBeams[id] = beamGroupId;
    });

    if (typeof showToast === 'function') {
      showToast('🔗 Notes liées par une liaison personnalisée !', 'success');
    }

    this.clearSelection();
    this._render();
  }

  /** Délie les notes sélectionnées. */
  unbeamSelectedNotes() {
    if (!this.selectedNoteIds || this.selectedNoteIds.length === 0) {
      if (typeof showToast === 'function') {
        showToast('⚠️ Sélectionnez des notes pour les délier.', 'error');
      }
      return;
    }

    this._pushHistory();

    if (!this.scoreData.customBeams) {
      this.scoreData.customBeams = {};
    }

    this.selectedNoteIds.forEach(id => {
      this.scoreData.customBeams[id] = 'none';
    });

    if (typeof showToast === 'function') {
      showToast('🔓 Liaisons personnalisées retirées !', 'success');
    }

    this.clearSelection();
    this._render();
  }

  /* ── Méthodes d'insertion, copie/coller et reconstruction de mesures ── */

  _getFlatVoice(hand) {
    const flat = [];
    this.scoreData.measures.forEach(m => {
      flat.push(...(m[hand] || []));
    });
    return flat;
  }

  _padVoice(flatVoice, targetDur, hand) {
    let currentDur = 0;
    flatVoice.forEach(n => { currentDur += n.duration; });

    let remaining = targetDur - currentDur;
    let pos = currentDur;
    const REST_DURS = [4.0, 3.0, 2.0, 1.5, 1.0, 0.75, 0.5, 0.375, 0.25];

    while (remaining > 0.01) {
      let chosen = REST_DURS.find(d => d <= remaining + 0.01);
      if (!chosen) {
        chosen = 0.25;
      }
      // Mapping durée → (durStr, dots) — gestion complète incluant valeurs pointées
      const DUR_MAP = {
        4.0: ['w', 0], 3.0: ['h', 1], 2.0: ['h', 0],
        1.5: ['q', 1], 1.0: ['q', 0], 0.75: ['8', 1],
        0.5: ['8', 0], 0.375: ['16', 1], 0.25: ['16', 0],
      };
      const [durStr, dots] = DUR_MAP[chosen] || ['16', 0];

      const restKey = getRestKey(durStr, hand, dots);
      flatVoice.push({
        id:          generateId(),
        keys:        [restKey],
        durationStr: durStr,
        dots:        dots,
        isRest:      true,
        startBeat:   pos,
        duration:    chosen,
        midiPitch:   null,
        hand:        hand,
        amplitude:   0,
      });

      remaining -= chosen;
      pos += chosen;
    }
  }

  _rebuildMeasures(flatTreble, flatBass) {
    const [num, den] = this.scoreData.timeSignature;
    const beatsPerMeasure = num * (4.0 / den);

    // Calculer la durée totale max
    let trebleDur = 0;
    flatTreble.forEach(n => { trebleDur += n.duration; });
    let bassDur = 0;
    flatBass.forEach(n => { bassDur += n.duration; });

    const maxDur = Math.max(trebleDur, bassDur);
    const numMeasures = Math.max(1, Math.ceil(maxDur / beatsPerMeasure));

    // Padder
    const targetDur = numMeasures * beatsPerMeasure;
    this._padVoice(flatTreble, targetDur, 'treble');
    this._padVoice(flatBass, targetDur, 'bass');

    // Recalculer les startBeat de façon robuste (arrondi pour éviter la dérive des flottants)
    let curTrebleBeat = 0;
    flatTreble.forEach(n => {
      n.startBeat = Math.round(curTrebleBeat * 1000) / 1000;
      curTrebleBeat = Math.round((curTrebleBeat + n.duration) * 1000) / 1000;
    });

    let curBassBeat = 0;
    flatBass.forEach(n => {
      n.startBeat = Math.round(curBassBeat * 1000) / 1000;
      curBassBeat = Math.round((curBassBeat + n.duration) * 1000) / 1000;
    });

    // Recréer le tableau de mesures
    const newMeasures = [];
    for (let i = 0; i < numMeasures; i++) {
      newMeasures.push({ treble: [], bass: [] });
    }

    flatTreble.forEach(n => {
      const mIdx = Math.floor((n.startBeat + 0.005) / beatsPerMeasure);
      if (mIdx < numMeasures) {
        newMeasures[mIdx].treble.push(n);
      }
    });

    flatBass.forEach(n => {
      const mIdx = Math.floor((n.startBeat + 0.005) / beatsPerMeasure);
      if (mIdx < numMeasures) {
        newMeasures[mIdx].bass.push(n);
      }
    });

    this.scoreData.measures = newMeasures;
    this.scoreData.totalMeasures = numMeasures;
  }

  insertNoteAfterSelected(isRest) {
    const found = this._findSelected();
    if (!found) {
      if (typeof showToast === 'function') {
        showToast('⚠️ Sélectionnez une note ou un silence pour insérer après.', 'error');
      }
      return;
    }

    this._pushHistory();

    const flatTreble = this._getFlatVoice('treble');
    const flatBass = this._getFlatVoice('bass');
    const flatVoice = found.hand === 'treble' ? flatTreble : flatBass;

    const idx = flatVoice.findIndex(n => n.id === this.selectedNoteId);
    if (idx === -1) return;

    const selected = flatVoice[idx];
    const targetStartBeat = selected.startBeat + selected.duration;
    
    let newNote;
    if (isRest) {
      const restKey = getRestKey('q', found.hand, 0);
      newNote = {
        id:          generateId(),
        keys:        [restKey],
        durationStr: 'q',
        dots:        0,
        isRest:      true,
        startBeat:   targetStartBeat,
        duration:    1.0,
        midiPitch:   null,
        hand:        found.hand,
        amplitude:   0,
      };
    } else {
      const pitch = selected.isRest ? (found.hand === 'treble' ? 60 : 48) : (selected.midiPitch || 60);
      const keySig = this.scoreData.keySignature || 'C';
      newNote = {
        id:          generateId(),
        keys:        [midiToVexflowKey(pitch, keySig)],
        durationStr: 'q',
        dots:        0,
        isRest:      false,
        startBeat:   targetStartBeat,
        duration:    1.0,
        midiPitch:   pitch,
        hand:        found.hand,
        amplitude:   0.7,
      };
    }

    const success = this._insertNoteIntoVoice(flatVoice, newNote, found.hand);
    if (!success) {
      this.historyIdx--;
      this.history.pop();
      return;
    }

    const [num, den] = this.scoreData.timeSignature || [4, 4];
    const beatsPerMeasure = num * (4.0 / den);
    const newMeasures = [];
    for (let i = 0; i < this.scoreData.totalMeasures; i++) {
        newMeasures.push({ treble: [], bass: [] });
    }
    flatTreble.forEach(n => {
        const mIdx = Math.floor((n.startBeat + 0.005) / beatsPerMeasure);
        if (mIdx >= 0 && mIdx < newMeasures.length) newMeasures[mIdx].treble.push(n);
    });
    flatBass.forEach(n => {
        const mIdx = Math.floor((n.startBeat + 0.005) / beatsPerMeasure);
        if (mIdx >= 0 && mIdx < newMeasures.length) newMeasures[mIdx].bass.push(n);
    });
    this.scoreData.measures = newMeasures;
    this._render();

    this.selectedNoteId = newNote.id;
    this.selectedNoteIds = [newNote.id];
    this.selectedKeyIdx = 0;
    this.renderer.highlightNote(this.selectedNoteIds, 0);
    this._updatePropsPanel(newNote);
    this._updateUndoRedo();

    if (typeof showToast === 'function') {
      showToast(isRest ? '➕ Silence inséré !' : '➕ Note insérée !', 'success');
    }
  }

  copySelected() {
    const found = this._findSelected();
    if (!found) {
      if (typeof showToast === 'function') {
        showToast('⚠️ Sélectionnez une note ou un silence à copier.', 'error');
      }
      return;
    }
    this.clipboard = this._clone(found.note);
    if (typeof showToast === 'function') {
      showToast(this.clipboard.isRest ? '📋 Silence copié !' : '📋 Note copiée !', 'success');
    }
  }

  pasteAfterSelected() {
    if (!this.clipboard) {
      if (typeof showToast === 'function') {
        showToast('⚠️ Presse-papiers vide. Copiez une note/silence d\'abord (Ctrl+C).', 'error');
      }
      return;
    }

    const found = this._findSelected();
    if (!found) {
      if (typeof showToast === 'function') {
        showToast('⚠️ Sélectionnez une note ou un silence pour coller après.', 'error');
      }
      return;
    }

    this._pushHistory();

    const flatTreble = this._getFlatVoice('treble');
    const flatBass = this._getFlatVoice('bass');
    const flatVoice = found.hand === 'treble' ? flatTreble : flatBass;

    const idx = flatVoice.findIndex(n => n.id === this.selectedNoteId);
    if (idx === -1) return;

    const selected = flatVoice[idx];
    const pasted = this._clone(this.clipboard);
    pasted.id = generateId();
    pasted.hand = found.hand;
    pasted.startBeat = selected.startBeat + selected.duration;

    if (pasted.isRest) {
      pasted.keys = [getRestKey(pasted.durationStr, found.hand, pasted.dots)];
    }

    const success = this._insertNoteIntoVoice(flatVoice, pasted, found.hand);
    if (!success) {
      this.historyIdx--;
      this.history.pop();
      return;
    }

    const [num, den] = this.scoreData.timeSignature || [4, 4];
    const beatsPerMeasure = num * (4.0 / den);
    const newMeasures = [];
    for (let i = 0; i < this.scoreData.totalMeasures; i++) {
        newMeasures.push({ treble: [], bass: [] });
    }
    flatTreble.forEach(n => {
        const mIdx = Math.floor((n.startBeat + 0.005) / beatsPerMeasure);
        if (mIdx >= 0 && mIdx < newMeasures.length) newMeasures[mIdx].treble.push(n);
    });
    flatBass.forEach(n => {
        const mIdx = Math.floor((n.startBeat + 0.005) / beatsPerMeasure);
        if (mIdx >= 0 && mIdx < newMeasures.length) newMeasures[mIdx].bass.push(n);
    });
    this.scoreData.measures = newMeasures;
    this._render();

    this.selectedNoteId = pasted.id;
    this.selectedNoteIds = [pasted.id];
    this.selectedKeyIdx = 0;
    this.renderer.highlightNote(this.selectedNoteIds, 0);
    this._updatePropsPanel(pasted);
    this._updateUndoRedo();

    if (typeof showToast === 'function') {
      showToast(pasted.isRest ? '📋 Silence collé !' : '📋 Note collé !', 'success');
    }
  }

  /**
   * Ajoute une note à l'accord sélectionné.
   * @param {number} midiPitch — pitch MIDI à ajouter
   */
  addNoteToChord(midiPitch) {
    const found = this._findSelected();
    if (!found || found.note.isRest) {
      if (typeof showToast === 'function') showToast('⚠️ Sélectionnez une note pour y ajouter une note d\'accord.', 'error');
      return;
    }

    this._pushHistory();

    const note   = found.note;
    const keySig = this.scoreData.keySignature || 'C';
    const newKey = midiToVexflowKey(midiPitch, keySig);

    // Éviter les doublons
    if (note.keys.includes(newKey)) {
      if (typeof showToast === 'function') showToast('ℹ️ Cette note est déjà dans l\'accord.', 'info');
      this.historyIdx--;
      this.history.pop();
      return;
    }

    note.keys.push(newKey);
    // Trier les notes de l'accord du grave vers l'aigu
    note.keys.sort((a, b) => vexflowKeyToMidi(a) - vexflowKeyToMidi(b));

    this._render();
    this._afterEdit(note);
    if (typeof showToast === 'function') showToast('➕ Note ajoutée à l\'accord.', 'success');
  }

  /**
   * Retire la note à l'index keyIdx de l'accord sélectionné.
   * Si l'accord n'a qu'une note, remplace par un silence.
   */
  removeNoteFromChord(keyIdx) {
    const found = this._findSelected();
    if (!found || found.note.isRest) {
      if (typeof showToast === 'function') showToast('⚠️ Sélectionnez une note à retirer.', 'error');
      return;
    }

    this._pushHistory();

    const note = found.note;
    const idx  = keyIdx ?? this.selectedKeyIdx ?? 0;

    if (note.keys.length <= 1) {
      // Dernière note → transformer en silence
      found.voiceArr[found.idx] = this._makeRest(note, found.hand);
      this.selectedNoteId  = null;
      this.selectedNoteIds = [];
      this.selectedKeyIdx  = 0;
      this._render();
      this._updatePropsPanel(null);
      this._updateUndoRedo();
      if (typeof showToast === 'function') showToast('🗑 Note supprimée de l\'accord (transformée en silence).', 'success');
      return;
    }

    note.keys.splice(idx, 1);
    if (idx === 0) note.midiPitch = vexflowKeyToMidi(note.keys[0]);
    this.selectedKeyIdx = 0;

    this._render();
    this._afterEdit(note);
    if (typeof showToast === 'function') showToast('🗑 Note retirée de l\'accord.', 'success');
  }

}

/* ─────────────────────────────────────────────────────────────────────────
   Méthodes de déplacement temporel (boutons ◀ ▶ et drag & drop)
   ───────────────────────────────────────────────────────────────────────── */
Object.assign(ScoreEditor.prototype, {

  /** Déplace la/les note(s) sélectionnée(s) d'un cran (direction = -1 ou +1). */
  shiftNoteTime(direction) {
    if (!this.selectedNoteId || !this.scoreData) {
      if (typeof showToast === 'function') showToast('⚠️ Sélectionnez une note pour la déplacer.', 'error');
      return;
    }
    if (this.selectedNoteIds && this.selectedNoteIds.length > 1) {
      this._shiftMultipleNotes(direction);
    } else {
      this._shiftSingleNote(direction);
    }
  },

  _shiftSingleNote(direction) {
    const found = this._findSelected();
    if (!found || found.note.isRest) {
      if (typeof showToast === 'function') showToast('⚠️ Sélectionnez une note (pas un silence) pour la déplacer.', 'error');
      return;
    }

    const hand = found.hand;
    const flatVoice = this._getFlatVoice(hand);
    const noteIdx   = flatVoice.findIndex(n => n.id === this.selectedNoteId);
    if (noteIdx === -1) return;

    const neighborIdx = noteIdx + direction;
    if (neighborIdx < 0 || neighborIdx >= flatVoice.length) {
      if (typeof showToast === 'function') showToast('⚠️ Impossible de déplacer au-delà de la partition.', 'error');
      return;
    }

    const neighbor = flatVoice[neighborIdx];
    if (!neighbor.isRest) {
      if (typeof showToast === 'function') showToast('⚠️ Position occupée par une autre note.', 'error');
      return;
    }

    const note = flatVoice[noteIdx];
    if (note.duration > neighbor.duration + 0.005) {
      if (typeof showToast === 'function') showToast('⚠️ La note est trop longue pour cet espace.', 'error');
      return;
    }

    this._pushHistory();

    const noteDur     = note.duration;
    const neighborDur = neighbor.duration;

    /* Silence de remplacement à l'ancienne position */
    const restAtOld = {
      id:          generateId(),
      keys:        [getRestKey(note.durationStr, hand, note.dots)],
      durationStr: note.durationStr,
      dots:        note.dots,
      isRest:      true,
      startBeat:   note.startBeat,
      duration:    noteDur,
      midiPitch:   null,
      hand,
      amplitude:   0,
    };

    const remainDur = Math.round((neighborDur - noteDur) * 1000) / 1000;
    const minIdx    = Math.min(noteIdx, neighborIdx);

    if (direction === 1) {
      /* Déplacement à droite : note → position du silence voisin */
      note.startBeat = neighbor.startBeat;
      const restsAfter = remainDur > 0.005
        ? this._makeRestsForDuration(note.startBeat + noteDur, remainDur, hand)
        : [];
      flatVoice.splice(minIdx, 2, restAtOld, note, ...restsAfter);
    } else {
      /* Déplacement à gauche : note → bord droit du silence voisin */
      const restsBefore = remainDur > 0.005
        ? this._makeRestsForDuration(neighbor.startBeat, remainDur, hand)
        : [];
      note.startBeat = neighbor.startBeat + remainDur;
      flatVoice.splice(minIdx, 2, ...restsBefore, note, restAtOld);
    }

    /* Reconstruction des mesures depuis les voix plates */
    const flatTreble = hand === 'treble' ? flatVoice : this._getFlatVoice('treble');
    const flatBass   = hand === 'bass'   ? flatVoice : this._getFlatVoice('bass');
    const [num, den] = this.scoreData.timeSignature || [4, 4];
    const beatsPerMeasure = num * (4.0 / den);
    const newMeasures = [];
    for (let i = 0; i < this.scoreData.totalMeasures; i++) {
        newMeasures.push({ treble: [], bass: [] });
    }
    flatTreble.forEach(n => {
        const mIdx = Math.floor((n.startBeat + 0.005) / beatsPerMeasure);
        if (mIdx >= 0 && mIdx < newMeasures.length) newMeasures[mIdx].treble.push(n);
    });
    flatBass.forEach(n => {
        const mIdx = Math.floor((n.startBeat + 0.005) / beatsPerMeasure);
        if (mIdx >= 0 && mIdx < newMeasures.length) newMeasures[mIdx].bass.push(n);
    });
    this.scoreData.measures = newMeasures;

    this._render();
    this.selectedNoteId  = note.id;
    this.selectedNoteIds = [note.id];
    this.selectedKeyIdx  = 0;
    this.renderer.highlightNote([note.id], 0);
    this._updatePropsPanel(note);
    this._updateUndoRedo();
  },

  _shiftMultipleNotes(direction) {
    /* Récupérer toutes les notes sélectionnées */
    const entries = this.selectedNoteIds
      .map(id => this._findById(id))
      .filter(e => e && !e.note.isRest);

    if (entries.length === 0) return;

    /* Toutes les notes doivent être sur la même portée */
    const hands = new Set(entries.map(e => e.hand));
    if (hands.size > 1) {
      if (typeof showToast === 'function') showToast('⚠️ Déplacement multi-sélection : sélectionnez des notes sur la même portée.', 'error');
      return;
    }

    const hand      = entries[0].hand;
    const flatVoice = this._getFlatVoice(hand);

    /* Trier les entrées par position dans la voix plate */
    entries.sort((a, b) => {
      const ia = flatVoice.findIndex(n => n.id === a.note.id);
      const ib = flatVoice.findIndex(n => n.id === b.note.id);
      return ia - ib;
    });

    /* Traiter de la fin vers le début pour direction=+1, du début à la fin sinon */
    const ordered = direction === 1 ? [...entries].reverse() : entries;

    this._pushHistory();

    for (const entry of ordered) {
      const idx = flatVoice.findIndex(n => n.id === entry.note.id);
      if (idx === -1) { this._revertLastHistory(); return; }

      const nIdx = idx + direction;
      if (nIdx < 0 || nIdx >= flatVoice.length) { this._revertLastHistory(); return; }

      const neighbor = flatVoice[nIdx];
      if (!neighbor.isRest) { this._revertLastHistory(); return; }

      const note    = flatVoice[idx];
      const noteDur = note.duration;
      const nborDur = neighbor.duration;
      if (noteDur > nborDur + 0.005) { this._revertLastHistory(); return; }

      const restAtOld = {
        id: generateId(), keys: [getRestKey(note.durationStr, hand, note.dots)],
        durationStr: note.durationStr, dots: note.dots, isRest: true,
        startBeat: note.startBeat, duration: noteDur,
        midiPitch: null, hand, amplitude: 0,
      };

      const remainDur = Math.round((nborDur - noteDur) * 1000) / 1000;
      const minIdx    = Math.min(idx, nIdx);

      if (direction === 1) {
        note.startBeat = neighbor.startBeat;
        const restsAfter = remainDur > 0.005
          ? this._makeRestsForDuration(note.startBeat + noteDur, remainDur, hand) : [];
        flatVoice.splice(minIdx, 2, restAtOld, note, ...restsAfter);
      } else {
        const restsBefore = remainDur > 0.005
          ? this._makeRestsForDuration(neighbor.startBeat, remainDur, hand) : [];
        note.startBeat = neighbor.startBeat + remainDur;
        flatVoice.splice(minIdx, 2, ...restsBefore, note, restAtOld);
      }
    }

    const flatTreble = hand === 'treble' ? flatVoice : this._getFlatVoice('treble');
    const flatBass   = hand === 'bass'   ? flatVoice : this._getFlatVoice('bass');
    const [num, den] = this.scoreData.timeSignature || [4, 4];
    const beatsPerMeasure = num * (4.0 / den);
    const newMeasures = [];
    for (let i = 0; i < this.scoreData.totalMeasures; i++) {
        newMeasures.push({ treble: [], bass: [] });
    }
    flatTreble.forEach(n => {
        const mIdx = Math.floor((n.startBeat + 0.005) / beatsPerMeasure);
        if (mIdx >= 0 && mIdx < newMeasures.length) newMeasures[mIdx].treble.push(n);
    });
    flatBass.forEach(n => {
        const mIdx = Math.floor((n.startBeat + 0.005) / beatsPerMeasure);
        if (mIdx >= 0 && mIdx < newMeasures.length) newMeasures[mIdx].bass.push(n);
    });
    this.scoreData.measures = newMeasures;

    this._render();
    this.renderer.highlightNote(this.selectedNoteIds, 0);
    this._updatePropsPanel({ isMulti: true, count: this.selectedNoteIds.length });
    this._updateUndoRedo();
  },

  /** Annule le dernier push dans l'historique (utilisé en cas d'erreur mid-opération). */
  _revertLastHistory() {
    if (this.historyIdx >= 0) {
      this.scoreData = this._clone(this.history[this.historyIdx]);
      this.history.pop();
      this.historyIdx--;
    }
    if (typeof showToast === 'function') showToast('⚠️ Déplacement impossible : position occupée ou en dehors de la partition.', 'error');
  },

  /**
   * Déplace une note vers un beat précis dans une mesure/portée donnée.
   * Utilisé par le drag & drop du renderer.
   */
  moveNoteToBeat(noteId, targetMeasureIdx, targetBeat, targetHand) {
    const found = this._findById(noteId);
    if (!found || found.note.isRest) return;

    const note    = found.note;
    const srcHand = found.hand;

    this._pushHistory();

    /* Remplacer la note source par un silence */
    found.voiceArr[found.idx] = this._makeRest(note, srcHand);

    /* Mettre à jour la note */
    note.startBeat = targetBeat;
    note.hand      = targetHand;

    /* Insérer dans la mesure cible */
    const targetMeasure = this.scoreData.measures[targetMeasureIdx];
    if (!targetMeasure) { this._revertLastHistory(); return; }

    const targetVoice = targetMeasure[targetHand];
    this._insertNoteIntoVoice(targetVoice, note, targetHand);

    this._render();
    this.selectedNoteId  = note.id;
    this.selectedNoteIds = [note.id];
    this.selectedKeyIdx  = 0;
    this.renderer.highlightNote([note.id], 0);
    this._afterEdit(note);
  },

});

