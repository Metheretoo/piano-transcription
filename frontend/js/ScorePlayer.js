/**
 * ScorePlayer.js — Lecteur audio synchronisé avec la partition
 *
 * Responsabilités :
 *  - Gérer la lecture audio synchronisée avec le défilement de la partition
 *  - Jouer les notes avec SoundFont ou synthétiseur MIDI
 *  - Synchroniser le temps de lecture avec le surlignage des notes
 *  - Gérer play/pause/stop/seek
 */
"use strict";

class ScorePlayer {
  constructor(renderer) {
    this.renderer = renderer;
    this.audioCtx = null;
    this.soundfont = null;
    this._scoreData = null;
    this._events = [];
    this._scheduledNodes = [];
    this._startTime = 0;
    this._pauseTime = 0;
    this._totalTime = 0;
    this.isPlaying = false;
    this.isPaused = false;
    this._animationFrameId = null;
    this._lastUpdateTime = 0;
  }

  /**
   * Charge le SoundFont et initialise l'audio context
   */
  async init() {
    try {
      // Initialiser l'audio context au premier clic utilisateur (pour éviter les restrictions navigateur)
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      // Charger le SoundFont
      if (!this.soundfont) {
        this.soundfont = await Soundfont.instrument(this.audioCtx, 'acoustic_grand_piano', {
          soundfont: 'MusyngKite',
          format: 'mp3',
          nameToUrl: (name, sf, format) => {
            // Utiliser notre fichier SoundFont local
            return `/js/lib/acoustic_grand_piano-${format}.js`;
          }
        });
      }
    } catch (e) {
      console.error('[ScorePlayer] Erreur initialisation:', e);
      if (typeof showToast === 'function') {
        showToast('❌ Erreur initialisation audio. Vérifiez la console.', 'error', 6000);
      }
    }
  }

  /**
   * Prépare la lecture pour un scoreData donné
   */
  preparePlayback(scoreData) {
    if (!scoreData) return;
    this._scoreData = scoreData;
    this._events = this._buildEvents(scoreData);
    this._totalTime = Math.max(...this._events.map(e => e.time + e.duration)) + 0.5;
  }

  /**
   * Construit la liste des événements audio à jouer
   */
  _buildEvents(scoreData) {
    const events = [];
    const tempo = scoreData.tempo || 120;
    const beatsPerSecond = tempo / 60.0;
    const secondsPerBeat = 1.0 / beatsPerSecond;
    // Construire les événements pour chaque note
    scoreData.measures.forEach(measure => {
      ['treble', 'bass'].forEach(hand => {
        (measure[hand] || []).forEach(note => {
          if (!note.isRest && note.midiPitch !== null) {
            const startTime = note.startBeat * secondsPerBeat;
            const duration = note.duration * secondsPerBeat;
            // Pour les accords, créer un événement par note
            note.keys.forEach((key, idx) => {
              const pitch = vexflowKeyToMidi(key);
              if (pitch !== null) {
                events.push({
                  time: startTime,
                  duration: duration,
                  pitch: pitch,
                  velocity: note.amplitude || 0.7,
                  noteId: note.id,
                  keyIdx: idx,
                  hand: hand
                });
              }
            });
          }
        });
      });
    });
    // Trier par temps de début
    events.sort((a, b) => a.time - b.time);
    return events;
  }

  /**
   * Démarre ou reprend la lecture
   */
  async play() {
    if (!this._scoreData) return;
    await this.init(); // S'assurer que l'audio context est initialisé
    if (this.isPaused) {
      // Reprendre depuis la pause
      this._startTime = this.audioCtx.currentTime - this._pauseTime;
      this.isPaused = false;
    } else {
      // Nouvelle lecture
      this._startTime = this.audioCtx.currentTime;
      this._pauseTime = 0;
    }
    this.isPlaying = true;
    this._scheduleNotes(0);
    this._startPlaybackAnimation();
    const btn = document.getElementById('btn-play-pause');
    if (btn) btn.textContent = '⏸ Pause';
  }

  /**
   * Met en pause la lecture
   */
  pause() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    this.isPaused = true;
    this._pauseTime = this.audioCtx.currentTime - this._startTime;
    this._stopAllSound();
    this._stopPlaybackAnimation();
    const btn = document.getElementById('btn-play-pause');
    if (btn) btn.textContent = '▶ Lire';
  }

  /**
   * Arrête la lecture
   */
  stop() {
    this.isPlaying = false;
    this.isPaused = false;
    this._pauseTime = 0;
    this._stopAllSound();
    this._stopPlaybackAnimation();
    const btn = document.getElementById('btn-play-pause');
    if (btn) btn.textContent = '▶ Lire';
  }

  /**
   * Bascule entre play et pause
   */
  async togglePlayPause(scoreData) {
    if (!scoreData) return;
    // Toujours mettre à jour au cas où la partition a été modifiée
    this.preparePlayback(scoreData);

    if (this.isPlaying) {
      this.pause();
    } else {
      await this.play();
    }
  }

  /**
   * Arrête tous les sons en cours
   */
  _stopAllSound() {
    if (this._scheduledNodes) {
      this._scheduledNodes.forEach(node => {
        if (node && typeof node.stop === 'function') {
          node.stop();
        }
      });
      this._scheduledNodes = [];
    }
  }

  /**
   * Planifie les notes à jouer à partir d'un temps donné (Lookahead scheduling)
   */
  _scheduleNotes(fromTime) {
    const engineSelect = document.getElementById('sound-engine');
    const engine = engineSelect ? engineSelect.value : 'soundfont';

    if (!this._events) return;
    if (engine === 'soundfont' && !this.soundfont) return;
    if (engine === 'synth' && !this.audioCtx) return;
    
    // Si fromTime est défini, on vient de faire un "play" ou un "seek", on réinitialise l'index
    if (fromTime !== undefined) {
      this._nextEventIndex = this._events.findIndex(e => e.time >= fromTime);
      if (this._nextEventIndex === -1) this._nextEventIndex = this._events.length;
    }

    if (this._nextEventIndex === undefined) return;

    const currentTime = this.audioCtx.currentTime;
    const songTime = currentTime - this._startTime;
    const lookahead = 0.5; // Planifier seulement 500ms à l'avance pour éviter de saturer l'AudioContext
    
    while (this._nextEventIndex < this._events.length) {
      const event = this._events[this._nextEventIndex];
      if (event.time > songTime + lookahead) break; // Note trop loin dans le futur
      
      const eventTime = this._startTime + event.time;
      // Ne jouer que si l'événement n'est pas déjà dans le passé (avec une petite tolérance)
      if (eventTime >= currentTime - 0.05) {
        const volInput = document.getElementById('volume-slider');
        const masterVolume = volInput ? parseFloat(volInput.value) : 1.0;
        const adjustedVelocity = event.velocity * masterVolume;

        let node = null;
        if (engine === 'soundfont') {
          node = this.soundfont.play(event.pitch, Math.max(currentTime, eventTime), {
            gain: adjustedVelocity,
            duration: event.duration
          });
        } else if (engine === 'synth') {
          node = this._playSynth(event.pitch, Math.max(currentTime, eventTime), event.duration, adjustedVelocity);
        }
        
        if (node) {
          this._scheduledNodes.push(node);
        }
      }
      this._nextEventIndex++;
    }
    
    // Nettoyage régulier du tableau des noeuds programmés pour éviter une fuite mémoire
    if (this._scheduledNodes.length > 200) {
      this._scheduledNodes = this._scheduledNodes.slice(-100);
    }
  }

  /**
   * Démarre l'animation de lecture et boucle de planification
   */
  _startPlaybackAnimation() {
    this._stopPlaybackAnimation();
    const update = () => {
      if (!this.isPlaying) return;
      
      // 1. Planifier les prochaines notes (Chunking)
      this._scheduleNotes();
      
      // 2. Mettre à jour l'UI
      const currentTime = this.audioCtx.currentTime - this._startTime;
      this._updatePlaybackPosition(currentTime);
      
      this._animationFrameId = requestAnimationFrame(update);
    };
    update();
  }

  /**
   * Arrête l'animation de lecture
   */
  _stopPlaybackAnimation() {
    if (this._animationFrameId) {
      cancelAnimationFrame(this._animationFrameId);
      this._animationFrameId = null;
    }
  }

  /**
   * Met à jour la position de lecture
   */
  _updatePlaybackPosition(currentTime) {
    const now = performance.now();
    if (now - this._lastUpdateTime < 50) return; // 20 FPS max
    this._lastUpdateTime = now;
    const timeline = document.getElementById('playback-timeline');
    const progressBar = document.getElementById('playback-progress-bar');
    const timeDisplay = document.getElementById('playback-time-display');
    if (timeline && progressBar) {
      const pct = Math.min(1, Math.max(0, currentTime / this._totalTime));
      progressBar.style.width = `${pct * 100}%`;
    }
    if (timeDisplay) {
      const current = formatTime(currentTime);
      const total = formatTime(this._totalTime);
      timeDisplay.textContent = `${current} / ${total}`;
    }
    const noteIds = [];
    this._events.forEach(event => {
      const start = event.time;
      const end = event.time + event.duration;
      if (currentTime >= start && currentTime <= end) noteIds.push(event.noteId);
    });
    this.renderer.highlightPlaybackNotes(noteIds);
  }

  /**
   * Déplace la position de lecture
   */
  seekTo(pct) {
    if (!this.isPlaying && !this.isPaused) return;
    const newTime = pct * this._totalTime;
    if (this.isPlaying) {
      this._stopAllSound();
      this._startTime = this.audioCtx.currentTime - newTime;
      this._scheduleNotes(newTime);
    } else if (this.isPaused) {
      this._pauseTime = newTime;
    }
    this._updatePlaybackPosition(newTime);
  }

  /**
   * Joue une note avec un synthétiseur basique
   */
  _playSynth(pitch, time, duration, velocity) {
    if (!this.audioCtx) return null;
    const osc = this.audioCtx.createOscillator();
    const gain = this.audioCtx.createGain();
    
    // Convertir MIDI pitch en fréquence
    const freq = 440 * Math.pow(2, (pitch - 69) / 12);
    osc.frequency.value = freq;
    osc.type = 'triangle'; // Un son plus doux
    
    // Enveloppe simple pour éviter les clics
    const start = time;
    const end = time + duration;
    const attack = 0.02;
    const release = 0.05;
    
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(velocity, start + attack);
    gain.gain.setValueAtTime(velocity, Math.max(start + attack, end - release));
    gain.gain.linearRampToValueAtTime(0, end);
    
    osc.connect(gain);
    gain.connect(this.audioCtx.destination);
    
    osc.start(start);
    osc.stop(end);
    
    return {
      stop: () => {
        try {
          osc.stop();
          osc.disconnect();
          gain.disconnect();
        } catch(e) {}
      }
    };
  }
}

// Fonctions utilitaires
function vexflowKeyToMidi(key) {
  const NOTE_ST = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  const parts = key.split('/');
  if (parts.length < 2) return null;
  const noteStr = parts[0].toLowerCase();
  const octave = parseInt(parts[1], 10);
  const baseLetter = noteStr[0];
  const base = NOTE_ST[baseLetter] ?? 0;
  const accidentals = noteStr.slice(1);
  const sharps = (accidentals.match(/#/g) || []).length;
  const flats = (accidentals.match(/b/g) || []).length;
  const mod = sharps - flats;
  return (octave + 1) * 12 + base + mod;
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
