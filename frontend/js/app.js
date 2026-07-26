/* Responsabilités :
 *  - Gestion upload (drag & drop + sélection)
 *  - Appel de l'API (/api/transcribe + SSE /api/transcribe-progress/<job_id>)
 *  - Affichage de la progression TEMPS RÉEL par étapes
 *  - Câblage de la barre d'outils (éditeur)
 *  - Export PDF (impression navigateur) et MIDI (API)
 *  - Raccourcis clavier
 *  - Toasts de notification
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   Initialisation
   ═══════════════════════════════════════════════════════════════════════════ */
let renderer = null;
let editor = null;
let player = null;
let currentJobId = null;
let currentPollingTimer = null;

document.addEventListener('DOMContentLoaded', () => {
  /* Notification onglet (alerte de fin) */
  window.originalDocumentTitle = document.title || 'AudioScore';
  window.addEventListener('focus', () => {
    if (document.title !== window.originalDocumentTitle) {
      document.title = window.originalDocumentTitle;
    }
  });

  /* Vérification VexFlow */
  if (typeof Vex === 'undefined' || !Vex.Flow) {
    showToast(
      '❌ VexFlow introuvable. Vérifiez que start.bat a bien téléchargé le fichier.',
      'error', 8000
    );
    return;
  }

  renderer = new ScoreRenderer('score-container');
  editor = new ScoreEditor(renderer);

  initUploadZone();
  initThresholdSlider();
  initAdaptiveThresholdSlider();
  initTranscriptionOptions();
  initToolbar();
  initKeyboardShortcuts();
  fetchDeviceInfo();
});

/* ═══════════════════════════════════════════════════════════════════════════
   Détection de la carte graphique
   ═══════════════════════════════════════════════════════════════════════════ */
async function fetchDeviceInfo() {
  const badge = document.getElementById('device-badge');
  const icon = document.getElementById('device-icon');
  const label = document.getElementById('device-label');
  if (!badge) return;

  try {
    const res = await fetch('/api/device');
    const data = await res.json();

    const device = data.device_type || 'unknown';
    const name = data.device_name || device.toUpperCase();

    const icons = { cuda: '🟢', mps: '🔵', cpu: '🟡', unknown: '🔴' };
    icon.textContent = icons[device] ?? '⚙️';
    label.textContent = name;

    badge.classList.remove('device-cuda', 'device-mps', 'device-cpu', 'device-unknown');
    badge.classList.add(`device-${device}`);

    const labels = { cuda: 'NVIDIA CUDA', mps: 'Apple Metal (MPS)', cpu: 'Processeur (CPU)', unknown: 'Inconnu' };
    badge.title = `Accélérateur IA : ${labels[device] ?? device} — ${name}`;

  } catch {
    icon.textContent = '⚙️';
    label.textContent = 'GPU inconnu';
    badge.classList.add('device-unknown');
    badge.title = 'Impossible de contacter le backend';
  }
}


/* ═══════════════════════════════════════════════════════════════════════════
   Zone d'upload
   ═══════════════════════════════════════════════════════════════════════════ */
function initUploadZone() {
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const transBtn = document.getElementById('btn-transcribe');
  const filenameEl = document.getElementById('selected-filename');

  let selectedFile = null;

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) selectFile(file);
  });

  dropZone.addEventListener('click', (e) => {
    if (e.target.id !== 'file-label' && !e.target.closest('#file-label')) {
      fileInput.click();
    }
  });

  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') fileInput.click();
  });

  ['dragenter', 'dragover'].forEach(ev => {
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(ev => {
    dropZone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
    });
  });

  dropZone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file) selectFile(file);
  });

  function selectFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['mp3', 'wav', 'flac'].includes(ext) && !file.type.includes('audio')) {
      showToast('⚠️ Veuillez sélectionner un fichier MP3, WAV ou FLAC.', 'error');
      return;
    }
    selectedFile = file;
    filenameEl.textContent = `📁 ${file.name}  (${formatSize(file.size)})`;
    transBtn.disabled = false;
  }

  transBtn.addEventListener('click', () => {
    if (!selectedFile) return;
    startTranscription(selectedFile);
  });

  document.getElementById('btn-new-upload')?.addEventListener('click', () => {
    if (player) player.stop();
    // Remettre à zéro la barre de progression de lecture (visuel uniquement, la lecture démarre bien au début)
    const playbackProgressBar = document.getElementById('playback-progress-bar');
    if (playbackProgressBar) playbackProgressBar.style.width = '0%';
    const playbackTimeDisplay = document.getElementById('playback-time-display');
    if (playbackTimeDisplay) {
      try {
        playbackTimeDisplay.textContent = `0:00 / ${playbackTimeDisplay.textContent.split(' / ').pop() || '0:00'}`;
      } catch (_) {
        playbackTimeDisplay.textContent = '0:00 / 0:00';
      }
    }
    updateProgress(0);
    showSection('upload');
    selectedFile = null;
    fileInput.value = '';
    filenameEl.textContent = 'Aucun fichier sélectionné';
    transBtn.disabled = true;
    currentJobId = null;
    window.currentScoreData = null;
    // NE PAS réinitialiser la mesure : garder la valeur du cache (comme les autres réglages)
    // L'override utilisateur est conservé pour ne pas perdre la valeur saisie
    // Seul le tempo détecté est réinitialisé (car spécifique au fichier audio)
    const timeSigSel = document.getElementById('time-sig');
    if (timeSigSel) {
      // Conserver userOverride si l'utilisateur a modifié la valeur
      // Ne pas effacer la valeur du select
    }
    const meterBadge = document.getElementById('meter-auto-badge');
    if (meterBadge) meterBadge.style.display = 'none';
    const tempoInfo = document.getElementById('tempo-detected-info');
    if (tempoInfo) tempoInfo.style.display = 'none';
    const sliderPanel = document.getElementById('tempo-adjust-panel');
    if (sliderPanel) sliderPanel.style.display = 'none';
    const warnPanel = document.getElementById('transcription-warnings');
    if (warnPanel) warnPanel.style.display = 'none';
    // Remasquer la section "Affichage de la partition" (visible uniquement après transcription)
    const displaySettings = document.querySelector('.show-before-score');
    if (displaySettings) displaySettings.style.display = 'none';
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Slider de seuil (Seuil de détection)
   ═══════════════════════════════════════════════════════════════════════════ */
function initThresholdSlider() {
  const slider = document.getElementById('onset-threshold');
  const display = document.getElementById('threshold-display');
  if (!slider || !display) return;

  // La valeur du slider est maintenant directement le seuil onset (0.20 → 0.85)
  // Pas besoin de conversion : slider.value = onset_threshold réel
  slider.addEventListener('input', () => {
    display.textContent = parseFloat(slider.value).toFixed(2);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Slider de seuil adaptatif (Seuil basses)
   ═══════════════════════════════════════════════════════════════════════════ */
function initAdaptiveThresholdSlider() {
  const slider = document.getElementById('bass-onset-threshold');
  const display = document.getElementById('bass-onset-threshold-display');
  if (!slider || !display) return;

  slider.addEventListener('input', () => {
    display.textContent = parseFloat(slider.value).toFixed(2);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Options de transcription
   ═══════════════════════════════════════════════════════════════════════════ */
function initTranscriptionOptions() {
  const hqCheckbox = document.getElementById('hq-piano-mode');
  let _updatingFromPresetMatch = false;
  const presetBtns = document.querySelectorAll('.preset-btn');

  const useDemucsCb = document.getElementById('use-demucs');
  const removeShortCb = document.getElementById('remove-short-notes');
  const minNoteInput = document.getElementById('min-note-duration');
  const mergeNearCb = document.getElementById('merge-near-notes');
  const mergeGapInput = document.getElementById('merge-gap-ms');
  const splitHandsCb = document.getElementById('split-hands');
  const detectTempoCb = document.getElementById('detect-tempo');
  const detectMeterCb = document.getElementById('detect-meter');
  const detectKeyCb = document.getElementById('detect-key');
  const enableRubato = document.getElementById('enable-rubato');
  const enableTriplets = document.getElementById('enable-triplets');
  const enable_smooth = document.getElementById('enable-smooth');
  const showChordsCb = document.getElementById('show-chords');
  const thresholdSlider = document.getElementById('onset-threshold');

  function getTranscriberValue() {
    const radio = document.querySelector('input[name="transcriber"]:checked');
    return radio ? radio.value : 'piano_transcription';
  }
  function setTranscriberValue(val) {
    const radio = document.querySelector(`input[name="transcriber"][value="${val}"]`);
    if (radio) radio.checked = true;
  }
  function getQuantizationValue() {
    const radio = document.querySelector('input[name="quantization"]:checked');
    return radio ? radio.value : 'standard';
  }
  function setQuantizationValue(val) {
    const radio = document.querySelector(`input[name="quantization"][value="${val}"]`);
    if (radio) radio.checked = true;
  }

   // Helper pour définir le filtrage harmonique
   function setHarmonicFilterValue(val) {
    const sel = document.getElementById('harmonic-filter');
    if (sel && val) sel.value = val;
    // Mettre à jour le label d'affichage
    const display = document.getElementById('harmonic-filter-display');
    if (display) {
      const labels = { off: 'Désactivé', basic: 'Basique', classical: 'Classique', 'classical-strong': 'Classique renforcé', 'transkun-chord': 'Transkun-chord (classique)', aggressive: 'Agressif', 'pedal-aware': 'Anti-pédale', ultra: 'Ultra', custom: 'Personnalisé' };
      display.textContent = labels[val] || 'Classique';
    }
    // Afficher/masquer les paramètres personnalisés
    updateCustomHarmonicVisibility(val);
  }

  function updateCustomHarmonicVisibility(value) {
    const panel = document.getElementById('custom-harmonic-params');
    if (panel) {
      panel.style.display = value === 'custom' ? 'block' : 'none';
    }
  }

  function applyPreset(presetName) {
    presetBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.preset === presetName);
    });

    const setHqChecked = (v) => {
      if (hqCheckbox && hqCheckbox.checked !== v) {
        _updatingFromPresetMatch = true;
        hqCheckbox.checked = v;
        _updatingFromPresetMatch = false;
      }
    };

    if (presetName === 'rapide') {
      // Basic Pitch est rapide et léger, idéal pour un aperçu immédiat
      setTranscriberValue('hft');
      if (useDemucsCb) useDemucsCb.checked = false;
      setQuantizationValue('none');
      if (removeShortCb) removeShortCb.checked = false;
      if (mergeNearCb) mergeNearCb.checked = false;
      if (splitHandsCb) splitHandsCb.checked = true;
      if (detectTempoCb) detectTempoCb.checked = true;
      if (detectMeterCb) detectMeterCb.checked = true;
      if (detectKeyCb) detectKeyCb.checked = true;
      if (enableRubato) enableRubato.checked = false;
      if (enableTriplets) enableTriplets.checked = false;
      if (enable_smooth) enable_smooth.checked = false;
      // Les toggles d'affichage sont maintenant masqués avant transcription
      // et synchronisés automatiquement après la transcription
      if (thresholdSlider) thresholdSlider.value = 0.85;  // basse sensibilité max
      setHarmonicFilterValue('off');
      if (qsSlider) qsSlider.value = 0.5;
    } else if (presetName === 'equilibre') {
      // Équilibré = Piano Transcription (pas Transkun) — slider de sensibilité fonctionnel
      setTranscriberValue('piano_transcription');
      if (useDemucsCb) useDemucsCb.checked = false;
      setQuantizationValue('standard');
      if (removeShortCb) removeShortCb.checked = false;
      if (minNoteInput) minNoteInput.value = 20;
      if (mergeNearCb) mergeNearCb.checked = false;
      if (mergeGapInput) mergeGapInput.value = 10;
      if (splitHandsCb) splitHandsCb.checked = true;
      if (detectTempoCb) detectTempoCb.checked = true;
      if (detectMeterCb) detectMeterCb.checked = true;
      if (detectKeyCb) detectKeyCb.checked = true;
      if (enableRubato) enableRubato.checked = false;
      if (enableTriplets) enableTriplets.checked = false;
      if (enable_smooth) enable_smooth.checked = false;
      // Les toggles d'affichage sont maintenant masqués avant transcription
      if (thresholdSlider) thresholdSlider.value = 0.55;
      if (qsSlider) qsSlider.value = 0.5;
      setHarmonicFilterValue('off');
    } else if (presetName === 'precision') {
      // Transkun + filtrage harmonique Transkun v2 (agressif) — optimal pour classique complexe
      setTranscriberValue('piano_transcription');
      if (useDemucsCb) useDemucsCb.checked = false;
      setQuantizationValue('heavy');
      if (removeShortCb) removeShortCb.checked = false;
      if (mergeNearCb) mergeNearCb.checked = false;
      if (splitHandsCb) splitHandsCb.checked = true;
      if (detectTempoCb) detectTempoCb.checked = true;
      if (detectMeterCb) detectMeterCb.checked = true;
      if (detectKeyCb) detectKeyCb.checked = true;
      if (enableRubato) enableRubato.checked = true;
      if (enableTriplets) enableTriplets.checked = true;
      if (enable_smooth) enable_smooth.checked = false;
      // Les toggles d'affichage sont maintenant masqués avant transcription
      if (thresholdSlider) thresholdSlider.value = 0.33;
      if (qsSlider) qsSlider.value = 0.5;
      // Utiliser le filtrage harmonique Transkun v2 (agressif) — élimine les notes en trop
      setHarmonicFilterValue('transkun-chord');
      if (qsSlider) qsSlider.value = 0.90;
    } else if (presetName === 'classique') {
      setTranscriberValue('piano_transcription');
      if (useDemucsCb) useDemucsCb.checked = false;
      setQuantizationValue('light');
      if (removeShortCb) removeShortCb.checked = false;
      if (mergeNearCb) mergeNearCb.checked = false;
      if (splitHandsCb) splitHandsCb.checked = true;
      if (detectTempoCb) detectTempoCb.checked = true;
      if (detectMeterCb) detectMeterCb.checked = true;
      if (detectKeyCb) detectKeyCb.checked = true;
      if (enableRubato) enableRubato.checked = true;
      if (enableTriplets) enableTriplets.checked = true;
      if (enable_smooth) enable_smooth.checked = false;
      // Les toggles d'affichage sont maintenant masqués avant transcription
      if (thresholdSlider) thresholdSlider.value = 0.20;  // Seuil le plus bas pour capter le maximum de notes
      if (qsSlider) qsSlider.value = 1;
      setHarmonicFilterValue('classical');
      // Activer le détection adaptative basses/aigus pour ce preset
      const adaptiveCb = document.getElementById('use-adaptive-threshold');
      if (adaptiveCb) adaptiveCb.checked = true;
      const bassOnsetSlider = document.getElementById('bass-onset-threshold');
      if (bassOnsetSlider) bassOnsetSlider.value = 0.10;  // Très sensible pour les basses
	} else if (presetName === 'jazz') {
      setTranscriberValue('piano_transcription');
      if (useDemucsCb) useDemucsCb.checked = false;
      setQuantizationValue('heavy');
      if (removeShortCb) removeShortCb.checked = false;
      if (minNoteInput) minNoteInput.value = 20;
      if (mergeNearCb) mergeNearCb.checked = false;
      if (mergeGapInput) mergeGapInput.value = 10;
      if (splitHandsCb) splitHandsCb.checked = true;
      if (detectTempoCb) detectTempoCb.checked = true;
      if (detectMeterCb) detectMeterCb.checked = true;
      if (detectKeyCb) detectKeyCb.checked = true;
      if (enableRubato) enableRubato.checked = false;
      if (enableTriplets) enableTriplets.checked = false;
      if (enable_smooth) enable_smooth.checked = true;
      // Les toggles d'affichage sont maintenant masqués avant transcription
      if (thresholdSlider) thresholdSlider.value = 0.67;
      if (qsSlider) qsSlider.value = 0.5;
      setHarmonicFilterValue('off');
    }

    const display = document.getElementById('threshold-display');
    if (display && thresholdSlider) {
      display.textContent = parseFloat(thresholdSlider.value).toFixed(2);
    }
    toggleManualFields();
    updateQuantizationSensitivitySlider();
  }

  function toggleManualFields() {
    const tempoOverrideItem = document.getElementById('tempo-override-item');
    if (tempoOverrideItem) {
      const disabled = detectTempoCb && detectTempoCb.checked;
      tempoOverrideItem.style.opacity = disabled ? '0.5' : '1';
      tempoOverrideItem.style.pointerEvents = disabled ? 'none' : 'auto';
      const tempoInput = document.getElementById('tempo-override');
      if (tempoInput && disabled) tempoInput.value = '';
    }
    
  // Griser le slider "Seuil de détection" quand Transkun est sélectionné
  // (inopérant car Transkun utilise ses propres seuils internes)
    const onsetSlider = document.getElementById('onset-threshold');
    const isTranskun = getTranscriberValue() === 'transkun';
    if (onsetSlider) {
      onsetSlider.disabled = isTranskun;
      onsetSlider.title = isTranskun
        ? 'Inopérant avec Transkun — utilise ses propres seuils internes'
        : 'Ajuste le seuil de détection des notes (0.20 = minimal → 0.85 = maximal)';
      // Style visuel flagrant pour Transkun
      if (isTranskun) {
        onsetSlider.style.opacity = '0.35';
        onsetSlider.style.cursor = 'not-allowed';
        onsetSlider.style.pointerEvents = 'none';
        onsetSlider.style.filter = 'grayscale(80%)';
      } else {
        onsetSlider.style.opacity = '1';
        onsetSlider.style.cursor = '';
        onsetSlider.style.pointerEvents = '';
        onsetSlider.style.filter = '';
      }
    }

    // Griser le checkbox "Seuil adaptatif basses/aigus" ET le slider "Sensibilité basses" quand Transkun est sélectionné
    // Ces options font partie du post-traitement et ne sont pas compatibles avec Transkun
    const adaptiveCheckbox = document.getElementById('use-adaptive-threshold');
    const bassOnsetSlider = document.getElementById('bass-onset-threshold');
    const bassThresholdItem = document.getElementById('adaptive-bass-threshold-item');
    
    if (adaptiveCheckbox && bassOnsetSlider && bassThresholdItem) {
      if (isTranskun) {
        adaptiveCheckbox.disabled = true;
        adaptiveCheckbox.style.opacity = '0.35';
        adaptiveCheckbox.style.cursor = 'not-allowed';
        adaptiveCheckbox.style.pointerEvents = 'none';
        adaptiveCheckbox.title = 'Incompatible avec Transkun — utilise ses propres seuils internes';
        
        bassOnsetSlider.disabled = true;
        bassOnsetSlider.style.opacity = '0.35';
        bassOnsetSlider.style.cursor = 'not-allowed';
        bassOnsetSlider.style.pointerEvents = 'none';
        bassOnsetSlider.style.filter = 'grayscale(80%)';
        bassOnsetSlider.title = 'Incompatible avec Transkun';
        
        bassThresholdItem.style.opacity = '0.35';
        bassThresholdItem.style.pointerEvents = 'none';
      } else {
        adaptiveCheckbox.disabled = false;
        adaptiveCheckbox.style.opacity = '1';
        adaptiveCheckbox.style.cursor = 'pointer';
        adaptiveCheckbox.style.pointerEvents = '';
        adaptiveCheckbox.title = 'Active un seuil de détection différentiel pour les basses et les aigus';
        
        // Gérer l'état du slider "Sensibilité basses" selon que le checkbox est coché ou non
        const adaptiveChecked = adaptiveCheckbox.checked;
        bassOnsetSlider.disabled = !adaptiveChecked;
        bassOnsetSlider.style.opacity = adaptiveChecked ? '1' : '0.35';
        bassOnsetSlider.style.cursor = adaptiveChecked ? 'pointer' : 'not-allowed';
        bassOnsetSlider.style.pointerEvents = adaptiveChecked ? '' : 'none';
        bassOnsetSlider.style.filter = adaptiveChecked ? '' : 'grayscale(80%)';
        bassOnsetSlider.title = adaptiveChecked
          ? 'Ajuste la sensibilité de détection pour les notes graves (main gauche)'
          : 'Désactivé — cocher "Seuil adaptatif basses/aigus" pour activer';
        
        bassThresholdItem.style.opacity = adaptiveChecked ? '1' : '0.35';
        bassThresholdItem.style.pointerEvents = adaptiveChecked ? '' : 'none';
      }
    }
  }

  const showPedalCb = document.getElementById('show-pedal-toolbar');
  const showChordsCbToggle = document.getElementById('show-chords-toolbar');
  const showHighestNoteCb = document.getElementById('show-highest-note-toolbar');
  const qsSlider = document.getElementById('quantization-sensitivity');
  const qsDisplay = document.getElementById('quantization-sensitivity-display');

  // Helper pour mettre à jour l'affichage de la Force d'alignement
  function updateQuantizationSensitivitySlider() {
    if (!qsSlider || !qsDisplay) return;
    const quantLevel = getQuantizationValue();
    if (quantLevel === 'none') {
      qsSlider.disabled = true;
      qsSlider.value = 0;
      qsDisplay.textContent = 'N/A';
    } else {
      qsSlider.disabled = false;
      if (qsSlider.value === '' || qsSlider.value === null) {
        qsSlider.value = 0.5;
      }
      qsDisplay.textContent = parseFloat(qsSlider.value).toFixed(2);
    }
  }

    function refreshDisplayToggles() {
      if (!renderer) return;
      
      // Sauvegarder les anciens états pour comparer
      const oldShowPedals = renderer.showPedals;
      const oldShowChordSymbols = renderer.showChordSymbols;
      
      // Mettre à jour les flags
      renderer.showPedals = showPedalCb ? showPedalCb.checked : true;
      renderer.showChordSymbols = showChordsCbToggle ? showChordsCbToggle.checked : false;
      renderer.showHighestNote = showHighestNoteCb ? showHighestNoteCb.checked : false;
      
      // Pour les toggles "Accords" et "Pédale", on doit re-render le SVG complet
      // car ces overlays sont dessinés pendant le render() (pas en post-render).
      // Pour "Note la plus haute", on peut utiliser renderHighestNoteLabels() sans
      // re-render car c'est un post-render.
      if (window.currentScoreData) {
        // Comparer les anciens et nouveaux états pour déterminer si un re-render est nécessaire
        const needsFullRender = (oldShowPedals !== renderer.showPedals) || (oldShowChordSymbols !== renderer.showChordSymbols);
        if (needsFullRender) {
          // Re-render complet pour mettre à jour pédale et accords en utilisant les données de l'éditeur pour conserver les modifs
          const scoreToRender = editor ? editor.getScoreData() : window.currentScoreData;
          renderer.render(scoreToRender);
          // Après le render, le highlight de sélection est perdu, le restaurer
          if (editor && editor.selectedNoteId) {
            renderer.highlightNote(editor.selectedNoteId, editor.selectedKeyIdx);
          }
        }
        // Pour "Note la plus haute", utiliser le post-render
        if (renderer.showHighestNote && typeof renderer.renderHighestNoteLabels === 'function') {
          renderer.renderHighestNoteLabels();
        } else if (!renderer.showHighestNote && typeof renderer.clearHighestNoteLabels === 'function') {
          renderer.clearHighestNoteLabels();
        }
      }
    }
  if (showPedalCb) showPedalCb.addEventListener('change', refreshDisplayToggles);
  if (showChordsCbToggle) showChordsCbToggle.addEventListener('change', refreshDisplayToggles);
  if (showHighestNoteCb) showHighestNoteCb.addEventListener('change', refreshDisplayToggles);


  if (qsSlider) {
    qsSlider.addEventListener('input', () => {
      qsDisplay.textContent = parseFloat(qsSlider.value).toFixed(2);
    });
  }

  presetBtns.forEach(btn => btn.addEventListener('click', () => applyPreset(btn.dataset.preset)));

  // Écouteurs pour les sliders de paramètres personnalisés du filtre harmonique
  const customHarmonicSliders = [
    { id: 'custom-harmonic-vel', displayId: 'custom-harmonic-vel-display' },
    { id: 'custom-harmonic-prot', displayId: 'custom-harmonic-prot-display' },
    { id: 'custom-harmonic-time', displayId: 'custom-harmonic-time-display' },
    { id: 'custom-harmonic-bass', displayId: 'custom-harmonic-bass-display' },
  ];
  customHarmonicSliders.forEach(({ id, displayId }) => {
    const slider = document.getElementById(id);
    const display = document.getElementById(displayId);
    if (slider && display) {
      slider.addEventListener('input', () => {
        display.textContent = parseFloat(slider.value).toFixed(3);
      });
    }
  });

  // Listener dédié pour le select harmonic-filter (affiche/masque les params custom)
  const harmonicFilterEl = document.getElementById('harmonic-filter');
  if (harmonicFilterEl) {
    harmonicFilterEl.addEventListener('change', () => {
      updateCustomHarmonicVisibility(harmonicFilterEl.value);
      checkPresetMatch();
      toggleManualFields();
    });
  }

  // Listener pour le slider "Protection basse" — affichage de la valeur avec labels
  const bassProtectionSlider = document.getElementById('bass-protection');
  const bassProtectionDisplay = document.getElementById('bass-protection-display');
  if (bassProtectionSlider && bassProtectionDisplay) {
    bassProtectionSlider.addEventListener('input', () => {
      const val = parseFloat(bassProtectionSlider.value);
      let label = 'Faible';
      if (val >= 0.55) label = 'Forte';
      else if (val >= 0.25) label = 'Moyenne';
      bassProtectionDisplay.textContent = label;
    });
    // Initialiser le label au chargement
    bassProtectionDisplay.textContent = 'Moyenne';
  }

  // Listener pour le select time-sig : marquer l'override utilisateur et sauvegarder
  const timeSigEl = document.getElementById('time-sig');
  if (timeSigEl) {
    timeSigEl.addEventListener('change', () => {
      // Marquer que l'utilisateur a modifié la valeur
      timeSigEl.dataset.userOverride = 'true';
      // Sauvegarder dans localStorage
      try {
        localStorage.setItem('audiosheet_time_sig', timeSigEl.value);
      } catch (e) { /* ignore */ }
    });
  }

  // Listener pour le checkbox "Seuil adaptatif basses/aigus" : griser/dégriser le slider "Sensibilité basses"
  const adaptiveCb = document.getElementById('use-adaptive-threshold');
  const bassOnsetSlider = document.getElementById('bass-onset-threshold');
  const bassThresholdItem = document.getElementById('adaptive-bass-threshold-item');
  if (adaptiveCb && bassOnsetSlider && bassThresholdItem) {
    adaptiveCb.addEventListener('change', () => {
      const isTranskun = getTranscriberValue() === 'transkun';
      if (isTranskun) return; // déjà géré par toggleManualFields
      const checked = adaptiveCb.checked;
      bassOnsetSlider.disabled = !checked;
      bassOnsetSlider.style.opacity = checked ? '1' : '0.35';
      bassOnsetSlider.style.cursor = checked ? 'pointer' : 'not-allowed';
      bassOnsetSlider.style.pointerEvents = checked ? '' : 'none';
      bassOnsetSlider.style.filter = checked ? '' : 'grayscale(80%)';
      bassOnsetSlider.title = checked
        ? 'Ajuste la sensibilité de détection pour les notes graves (main gauche)'
        : 'Désactivé — cocher "Seuil adaptatif basses/aigus" pour activer';
      bassThresholdItem.style.opacity = checked ? '1' : '0.35';
      bassThresholdItem.style.pointerEvents = checked ? '' : 'none';
    });
  }

  // Tous les contrôles sauf harmonic-filter (déjà traité ci-dessus)
  const allControls = [
    useDemucsCb, removeShortCb, minNoteInput, mergeNearCb, mergeGapInput,
    splitHandsCb, detectTempoCb, detectKeyCb, thresholdSlider, enableRubato, enableTriplets,
  ];
  allControls.forEach(ctrl => {
    if (!ctrl) return;
    ctrl.addEventListener('change', () => { checkPresetMatch(); toggleManualFields(); });
    if (ctrl.tagName === 'INPUT' && (ctrl.type === 'number' || ctrl.type === 'range')) {
      ctrl.addEventListener('input', () => { checkPresetMatch(); toggleManualFields(); });
    }
  });
  document.querySelectorAll('input[name="transcriber"]').forEach(r => r.addEventListener('change', () => { checkPresetMatch(); toggleManualFields(); updateQuantizationSensitivitySlider(); }));
  document.querySelectorAll('input[name="quantization"]').forEach(r => r.addEventListener('change', () => { checkPresetMatch(); toggleManualFields(); updateQuantizationSensitivitySlider(); }));

  function checkPresetMatch() {
    const ct = getTranscriberValue();
    const cd = useDemucsCb ? useDemucsCb.checked : false;
    const cq = getQuantizationValue();
    const crs = removeShortCb ? removeShortCb.checked : false;
    const cmn = mergeNearCb ? mergeNearCb.checked : false;
    const csh = splitHandsCb ? splitHandsCb.checked : false;
    const cdt = detectTempoCb ? detectTempoCb.checked : false;
    const cdk = detectKeyCb ? detectKeyCb.checked : false;
    const crb = enableRubato ? enableRubato.checked : false;
    const ctr = enableTriplets ? enableTriplets.checked : false;
    const ctH = thresholdSlider ? parseFloat(thresholdSlider.value) : 0.50;
    const setHq = (v) => { if (hqCheckbox && hqCheckbox.checked !== v) { _updatingFromPresetMatch = true; hqCheckbox.checked = v; _updatingFromPresetMatch = false; } };

    if (ct === 'piano_transcription' && cd && cq === 'standard' && !crs && !cmn && csh && cdt && cdk && crb && ctr) {
      presetBtns.forEach(b => b.classList.toggle('active', b.dataset.preset === 'studio'));
      setHq(true);
    } else if (ct === 'piano_transcription' && !cd && cq === 'standard' && !crs && !cmn && csh && cdt && cdk && !crb && !ctr) {
      presetBtns.forEach(b => b.classList.toggle('active', b.dataset.preset === 'equilibre'));
      setHq(false);
    } else if (ct === 'basic_pitch' && !cd && cq === 'light' && !crs && !cmn && !csh && !cdt && !cdk && !crb && !ctr) {
      presetBtns.forEach(b => b.classList.toggle('active', b.dataset.preset === 'rapide'));
      setHq(false);
    } else if (ct === 'piano_transcription' && cd && cq === 'heavy' && !crs && !cmn && csh && cdt && cdk && !crb && !ctr && Math.abs(ctH - 0.50) < 0.01) {
      presetBtns.forEach(b => b.classList.toggle('active', b.dataset.preset === 'jazz'));
      setHq(false);
    } else if (ct === 'transkun' && cd && cq === 'heavy' && !crs && !cmn && csh && cdt && cdk && crb && ctr && Math.abs(ctH - 0.90) < 0.01) {
      presetBtns.forEach(b => b.classList.toggle('active', b.dataset.preset === 'precision'));
      setHq(false);
    } else {
      presetBtns.forEach(b => b.classList.remove('active'));
      setHq(false);
    }
  }

  applyPreset('equilibre');

  // Restaurer la mesure sauvegardée depuis le localStorage
  try {
    const savedTimeSig = localStorage.getItem('audiosheet_time_sig');
    if (savedTimeSig && timeSigEl) {
      const hasOption = Array.from(timeSigEl.options).some(o => o.value === savedTimeSig);
      if (hasOption) {
        timeSigEl.value = savedTimeSig;
        timeSigEl.dataset.userOverride = 'saved';
      }
    }
  } catch (e) { /* ignore */ }
}


/* ═══════════════════════════════════════════════════════════════════════════
   SSE Progress subscription (Stream Server Events)
   ═══════════════════════════════════════════════════════════════════════════ */
let currentSSESource = null;

function subscribeToProgress(jobId) {
  // Nettoyer toute connexion SSE précédente
  if (currentSSESource) {
    currentSSESource.close();
    currentSSESource = null;
  }

  setLoadingStep('🔍 Connexion au serveur…');

  currentSSESource = new EventSource(`/api/transcribe-progress/${jobId}`);

  // Événement de statut (progression détaillée)
   currentSSESource.addEventListener('status', (e) => {
     try {
       const data = JSON.parse(e.data);
       
       const step = data.step || 'transcription';
       const message = data.message || 'Transcription en cours…';
       const progress = data.progress || 0;
       
       updateProgress(progress * 100);
       
       // Mettre à jour les étapes détaillées
       updatePipelineStage(step, data.done_steps || []);
       
       // Mettre à jour le nom du transcripteur si présent
       if (data.transcriber_name) {
         const transcriberLabel = document.getElementById('transcriber-label');
         if (transcriberLabel) {
           transcriberLabel.textContent = data.transcriber_name;
         }
       }
       
       // Mapper les étapes du backend vers des messages frontend
       const stepMessages = {
         'init': '🔍 Initialisation du modèle...',
         'load_audio': '🎵 Chargement de l\'audio...',
         'demucs': '🔊 Prétraitement audio (Demucs)...',
         'transcription': message,
         'filtering': '🧹 Filtrage des notes...',
         'tempomap': '📊 Analyse du tempo...',
         'quantization': '📐 Quantification rythmique...',
         'voice_split': '✋ Séparation des mains...',
         'score_build': '🎼 Construction de la partition...',
         'export': '💾 Export des fichiers...',
       };
       
       const displayMessage = stepMessages[step] || message;
       setLoadingStep(displayMessage);
       
     } catch (err) {
       console.error('[SSE] Erreur parsing status:', err);
     }
   });

  // Événement de succès
  currentSSESource.addEventListener('done', async (e) => {
    
    // Fermer le flux SSE
    if (currentSSESource) {
      currentSSESource.close();
      currentSSESource = null;
    }
    clearInterval(currentPollingTimer);
    currentPollingTimer = null;
    
    updateProgress(100);
    setLoadingStep('✅ Transcription terminée');
    
    // Attendre 500ms pour s'assurer que le job est bien terminé côté serveur
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Récupérer le résultat final avec retry
    const maxRetries = 3;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const res = await fetch(`/api/transcribe/result/${jobId}`);
        
        if (!res.ok) {
          console.warn(`[SSE] HTTP ${res.status}, retry ${i + 1}/${maxRetries}...`);
          if (i < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
          }
          throw new Error(`HTTP ${res.status}`);
        }
        
        const result = await res.json();
        
        if (result.success && result.score_data && result.score_data.measures && result.score_data.measures.length > 0) {
          handleTranscriptionResult(result);
        } else {
          console.warn('[SSE] Resultat sans score_data, tentative de polling direct...');
          // Fallback: polling direct
          await fallbackPolling(jobId);
        }
        break;
      } catch (err) {
        console.error(`[SSE] Erreur tentative ${i + 1}:`, err);
        if (i < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        } else {
          // Dernier retry échoué: fallback direct
          console.warn('[SSE] Tous les retries échoués, fallback polling...');
          await fallbackPolling(jobId);
        }
      }
    }
  });

  // Fonction de fallback: polling direct du status
  async function fallbackPolling(id) {
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      try {
        const res = await fetch(`/api/transcribe/result/${id}`);
        if (res.ok) {
          const result = await res.json();
          if (result.success && result.score_data) {
            handleTranscriptionResult(result);
            return;
          }
        } else if (res.status === 202) {
          continue;
        }
      } catch (err) {
        console.warn('[SSE] Fallback polling erreur:', err);
      }
    }
    // Échec total
    console.error('[SSE] Fallback polling échoué');
    showSection('upload');
    showToast('❌ La transcription est terminée mais la partition n\'a pas pu être chargée. Réessayez.', 'error', 8000);
  }

  // Événement d'erreur
  currentSSESource.addEventListener('error', (e) => {
    console.error('[SSE] Erreur de connexion:', e);
    console.error('[SSE] ReadyState:', e.currentTarget.readyState);
    console.error('[SSE] URL:', e.currentTarget.url);
    
    // ReadyState: 0=CONNECTING, 1=OPEN, 2=CLOSED
    if (e.currentTarget.readyState === EventSource.CLOSED) {
    } else {
      console.warn('[SSE] Erreur HTTP détectée, tentative de récupération du résultat...');
      // Tenter de récupérer le résultat quand même
      fetch(`/api/transcribe/result/${jobId}`)
        .then(res => res.json())
        .then(result => {
          if (result.success && result.score_data) {
            handleTranscriptionResult(result);
          } else {
            console.error('[SSE] Résultat d\'erreur:', result);
            showSection('upload');
            showToast(`❌ ${result.error || 'Échec de la transcription'}`, 'error', 8000);
          }
        })
        .catch(err => {
          console.error('[SSE] Erreur récupération résultat:', err);
          showSection('upload');
          showToast('❌ Erreur lors de la récupération du résultat', 'error', 8000);
        });
    }
    
    clearInterval(currentPollingTimer);
    currentPollingTimer = null;
    if (currentSSESource) {
      currentSSESource.close();
      currentSSESource = null;
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Lancer la transcription
   ═══════════════════════════════════════════════════════════════════════════ */
async function startTranscription(file) {
  const modelLabel = document.querySelector('input[name="transcriber"]:checked')?.value || 'piano_transcription';

  resetProgressUI();
  showSection('loading');
  document.title = `⏳ Transcription en cours... - ${window.originalDocumentTitle}`;

  const formData = new FormData();
  formData.append('audio', file, file.name);
  formData.append('onset_threshold', parseFloat(document.getElementById('onset-threshold').value));
  formData.append('frame_threshold', document.getElementById('frame-threshold')?.value || '0.1');
  formData.append('offset_threshold', document.getElementById('offset-threshold')?.value || '0.3');
  formData.append('transcriber', document.querySelector('input[name="transcriber"]:checked')?.value || 'piano_transcription');
  formData.append('quantization_level', document.querySelector('input[name="quantization"]:checked')?.value || 'standard');  formData.append('use_demucs', document.getElementById('use-demucs')?.checked ? 'true' : 'false');
  formData.append('remove_short_notes', document.getElementById('remove-short-notes')?.checked ? 'true' : 'false');
  formData.append('minimum_note_duration', document.getElementById('min-note-duration')?.value || '50');
  formData.append('merge_near_notes', document.getElementById('merge-near-notes')?.checked ? 'true' : 'false');
  formData.append('merge_gap_ms', document.getElementById('merge-gap-ms')?.value || '30');
  formData.append('split_hands', document.getElementById('split-hands')?.checked ? 'true' : 'false');
  formData.append('detect_tempo', document.getElementById('detect-tempo')?.checked ? 'true' : 'false');
  formData.append('detect_meter', document.getElementById('detect-meter')?.checked ? 'true' : 'false');
  formData.append('detect_key', document.getElementById('detect-key')?.checked ? 'true' : 'false');
  formData.append('enable_rubato', document.getElementById('enable-rubato')?.checked ? 'true' : 'false');
  formData.append('enable_triplets', document.getElementById('enable-triplets')?.checked ? 'true' : 'false');
  formData.append('enable_smooth', document.getElementById('enable-smooth')?.checked ? 'true' : 'false');
  formData.append('strict_mode', document.getElementById('strict-mode')?.checked ? 'true' : 'false');
  const qsSliderLocal = document.getElementById('quantization-sensitivity');
  if (qsSliderLocal && qsSliderLocal.value !== '') {
   formData.append('quantization_sensitivity', qsSliderLocal.value);
  }
  const harmonicFilterEl = document.getElementById('harmonic-filter');
  const harmonicFilterValue = harmonicFilterEl?.value || 'classical';
  formData.append('harmonic_filter', harmonicFilterValue);
   
  // Si le mode 'custom' est actif, envoyer les paramètres personnalisés
  if (harmonicFilterValue === 'custom') {
     const customVel = document.getElementById('custom-harmonic-vel')?.value;
     const customProt = document.getElementById('custom-harmonic-prot')?.value;
     const customTime = document.getElementById('custom-harmonic-time')?.value;
     const customBass = document.getElementById('custom-harmonic-bass')?.value;
     if (customVel !== undefined && customVel !== '') {
       formData.append('harmonic_velocity_ratio', customVel);
     }
     if (customProt !== undefined && customProt !== '') {
       formData.append('harmonic_protection_threshold', customProt);
     }
     if (customTime !== undefined && customTime !== '') {
       formData.append('harmonic_time_tolerance', customTime);
     }
    if (customBass !== undefined && customBass !== '') {
      formData.append('harmonic_bass_threshold', customBass);
    }
  }

  // NOUVEAU : Protection basse (main gauche)
  const bassProtection = document.getElementById('bass-protection')?.value;
  if (bassProtection !== undefined && bassProtection !== '') {
    formData.append('bass_protection_velocity', bassProtection);
  }
    
  // NOUVEAU : Seuil adaptatif basses/aigus
  const useAdaptiveThreshold = document.getElementById('use-adaptive-threshold')?.checked;
  formData.append('use_adaptive_threshold', useAdaptiveThreshold);
    
  const bassOnsetThreshold = document.getElementById('bass-onset-threshold')?.value;
  if (bassOnsetThreshold !== undefined && bassOnsetThreshold !== '') {
    formData.append('bass_onset_threshold', bassOnsetThreshold);
  }
    
  formData.append('time_sig', document.getElementById('time-sig')?.value || '4/4');
  formData.append('key_sig', document.getElementById('key-sig-upload')?.value || document.getElementById('key-sig-toolbar')?.value || 'C');

  const tempoOverride = document.getElementById('tempo-override')?.value;
  if (tempoOverride) formData.append('tempo', tempoOverride);

  try {
    const response = await fetch('/api/transcribe', { method: 'POST', body: formData });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `Erreur HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!data.success) {
      throw new Error(data.error || 'Échec de la transcription');
    }

    const jobId = data.jobId;
    currentJobId = jobId;

    /* Démarrer le polling de progression */
    subscribeToProgress(jobId);

  } catch (err) {
    showSection('upload');
    showToast(`❌ Erreur : ${err.message}`, 'error', 8000);
    console.error('[Transcription]', err);

    if (document.hidden) {
      document.title = `(1) ❌ Erreur - ${window.originalDocumentTitle}`;
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Mise à jour des étapes détaillées (pipeline)
   ═══════════════════════════════════════════════════════════════════════════ */
function updatePipelineStage(currentStep, doneSteps = []) {
  // Mapping des step backend vers les data-step du HTML
  const stepToDataStep = {
    'init': 'init',
    'load_audio': 'init',
    'demucs': 'demucs',
    'transcription': 'transcription',
    'quantize': 'quantize',
    'quantization': 'quantize',
    'build': 'build',
    'score_build': 'build',
    'export': 'export',
  };
  
  // Normaliser le nom de l'étape actuelle
  const normalizedStep = stepToDataStep[currentStep] || currentStep;
  
  document.querySelectorAll('.stage-item').forEach(el => {
    const stepName = el.dataset.step;
    const icon = el.querySelector('.stage-icon');
    
    // Réinitialiser les classes
    el.classList.remove('active', 'done');
    
    if (doneSteps.includes(stepName) || (stepName === normalizedStep && doneSteps.includes(stepName))) {
      // Étape terminée (dans doneSteps)
      el.classList.add('done');
      icon.textContent = '✅';
    } else if (stepName === normalizedStep) {
      // Étape en cours
      el.classList.add('active');
      icon.textContent = '⏳';
    } else {
      // Étape en attente
      icon.textContent = '⏳';
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Mise à jour des badges de stade
   ═══════════════════════════════════════════════════════════════════════════ */
function updateStageBadgesForStep(step) {
  const stepToId = {
    'init': 'load_audio',
    'preprocess': 'load_audio',
    'demucs': 'demucs',
    'transcription': 'transcribe',
    'quantization': 'quantize',
    'split_hands': 'split_hands',
    'export': 'build_score',
    'done': 'export',
  };
  const stageId = stepToId[step];
  if (!stageId) return;

  ['load_audio', 'demucs', 'transcribe', 'quantize', 'split_hands', 'build_score', 'export'].forEach(id => {
    const badge = document.getElementById(`stage-${id}`);
    if (!badge) return;
    badge.classList.remove('active', 'completed', 'pending');
    if (id === stageId) badge.classList.add('active');
    else if (['load_audio', 'demucs', 'transcribe', 'quantize', 'split_hands', 'build_score', 'export'].indexOf(id) < ['load_audio', 'demucs', 'transcribe', 'quantize', 'split_hands', 'build_score', 'export'].indexOf(stageId)) {
      badge.classList.add('completed');
    } else {
      badge.classList.add('pending');
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   UI Progression
   ═══════════════════════════════════════════════════════════════════════════ */
function resetProgressUI() {
  updateProgress(0);
  setLoadingStep('Initialisation…');
  ['load_audio', 'demucs', 'transcribe', 'quantize', 'split_hands', 'build_score', 'export'].forEach(id => {
    const badge = document.getElementById(`stage-${id}`);
    if (badge) { badge.classList.remove('active', 'completed'); badge.classList.add('pending'); }
  });
}

function updateProgress(pct) {
  const fill = document.getElementById('progress-fill');
  if (fill) fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
}

function setLoadingStep(text) {
  const el = document.getElementById('loading-step');
  if (el) el.textContent = text;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Résultat transcription
   ═══════════════════════════════════════════════════════════════════════════ */
function handleTranscriptionResult(result) {
  const { success, score_data, output_files, error, processing_time } = result;

  if (!success) {
    showSection('upload');
    showToast(`❌ Erreur : ${error}`, 'error', 8000);
    return;
  }

  if (!score_data || !score_data.measures || score_data.measures.length === 0) {
    showSection('upload');
    showToast('❌ Aucune note détectée. Essayez un seuil de détection plus bas.', 'error', 8000);
    return;
  }

  currentJobId = score_data.jobId;

  sleep(400).then(() => {
    showSection('score');

    // Remettre à zéro la barre de progression de lecture pour la nouvelle partition
    const playbackProgressBar = document.getElementById('playback-progress-bar');
    if (playbackProgressBar) playbackProgressBar.style.width = '0%';
    const playbackTimeDisplay = document.getElementById('playback-time-display');
    if (playbackTimeDisplay) playbackTimeDisplay.textContent = '0:00 / 0:00';

  const detectedKey = score_data.keySignature;
    const detectKeyCb = document.getElementById('detect-key');
    const useManualKey = detectKeyCb && !detectKeyCb.checked;
    const keySigToolbar = document.getElementById('key-sig-toolbar');
    if (keySigToolbar && !useManualKey && detectedKey) {
      keySigToolbar.value = detectedKey;
    }

    if (renderer) {
      const showPedalCb = document.getElementById('show-pedal-toolbar');
      const showChordsCb = document.getElementById('show-chords-toolbar');
      const showHighestNoteCb = document.getElementById('show-highest-note-toolbar');
      renderer.showPedals = showPedalCb ? showPedalCb.checked : true;
      renderer.showChordSymbols = showChordsCb ? showChordsCb.checked : true;
      renderer.showHighestNote = showHighestNoteCb ? showHighestNoteCb.checked : true;
    }

    editor.loadScore(score_data);
    if (editor && typeof editor.setKeySignature === 'function') editor.setKeySignature(detectedKey);

    window.currentScoreData = score_data;

    // ✅ Rendre les noms de notes les plus hautes après chargement de la partition
    if (renderer && renderer.showHighestNote && typeof renderer.renderHighestNoteLabels === 'function') {
      renderer.renderHighestNoteLabels();
    }

    // ✅ Synchroniser les cases à cocher AVEC TOUS LES TOGGLES (section upload + toolbar)
    // (les presets ont configuré les valeurs par défaut, mais le renderer a ses propres valeurs)
    const showPedalCb = document.getElementById('show-pedal');
    const showPedalToolbarCb = document.getElementById('show-pedal-toolbar');
    const showChordsCb = document.getElementById('show-chords');
    const showChordsToolbarCb = document.getElementById('show-chords-toolbar');
    const showHighestNoteCb = document.getElementById('show-highest-note');
    const showHighestNoteToolbarCb = document.getElementById('show-highest-note-toolbar');
    if (showPedalCb) showPedalCb.checked = renderer.showPedals;
    if (showPedalToolbarCb) showPedalToolbarCb.checked = renderer.showPedals;
    if (showChordsCb) showChordsCb.checked = renderer.showChordSymbols;
    if (showChordsToolbarCb) showChordsToolbarCb.checked = renderer.showChordSymbols;
    if (showHighestNoteCb) showHighestNoteCb.checked = renderer.showHighestNote;
    if (showHighestNoteToolbarCb) showHighestNoteToolbarCb.checked = renderer.showHighestNote;

    // ✅ Afficher les toggles de la section upload (masqués par défaut)
    const displaySettings = document.querySelector('.show-before-score');
    if (displaySettings) displaySettings.style.display = '';

    if (score_data.tempoMapMethod) { updateTempoDisplay(score_data); initTempoSlider(score_data.tempo); }
    if (score_data.detectedMeter) updateDetectedMeter(score_data.detectedMeter);
    displayWarnings(score_data.warnings);

    showToast(
      `✅ Partition générée — ${score_data.totalMeasures} mesure(s) · ${score_data.tempo} BPM · ${processing_time.toFixed(1)}s`,
      'success'
    );

    if (document.hidden) {
      document.title = `(1) ✅ Terminée ! - ${window.originalDocumentTitle}`;
    }
  });
}

function cancelTranscription() {
  if (!currentJobId) return;
  fetch(`/api/transcribe/cancel/${currentJobId}`, { method: 'POST' })
    .then(() => {
      if (currentPollingTimer) { clearInterval(currentPollingTimer); currentPollingTimer = null; }
      showSection('upload');
      showToast('⏹️ Transcription annulée', 'info');
    })
    .catch(err => showToast(`❌ Erreur annulation : ${err.message}`, 'error'));
}

/* ═══════════════════════════════════════════════════════════════════════════
   V2 — Affichage dynamique du tempo détecté
   ═══════════════════════════════════════════════════════════════════════════ */
function updateTempoDisplay(scoreData) {
  const infoDiv = document.getElementById('tempo-detected-info');
  if (!infoDiv) return;

  const bpmEl = document.getElementById('tempo-detected-value');
  if (bpmEl) bpmEl.textContent = `${scoreData.tempo} BPM`;

  const methodBadge = document.getElementById('tempo-method-badge');
  const methodColors = {
    'madmom': { label: 'TempoMap Pro', color: '#22c55e', bg: 'rgba(34,197,94,0.15)' },
    'librosa_advanced': { label: 'TempoMap Standard', color: '#f59e0b', bg: 'rgba(245,158,11,0.15)' },
    'fallback': { label: 'Estimation basique', color: '#ef4444', bg: 'rgba(239,68,68,0.15)' },
  };
  const m = methodColors[scoreData.tempoMapMethod] || { label: scoreData.tempoMapMethod, color: '#94a3b8', bg: 'rgba(148,163,184,0.12)' };
  if (methodBadge) {
    methodBadge.textContent = m.label;
    methodBadge.style.color = m.color;
    methodBadge.style.background = m.bg;
    methodBadge.style.borderColor = m.color;
  }

  const confBar = document.getElementById('tempo-confidence-bar');
  const confLabel = document.getElementById('tempo-confidence-label');
  if (confBar && scoreData.tempoConfidence !== undefined) {
    const pct = Math.round(scoreData.tempoConfidence * 100);
    confBar.style.width = `${pct}%`;
    confBar.style.background = pct >= 80 ? '#22c55e' : pct >= 55 ? '#f59e0b' : '#ef4444';
    if (confLabel) confLabel.textContent = `${pct}%`;
  }

  const rangeEl = document.getElementById('tempo-range-label');
  if (rangeEl && scoreData.tempoRange) {
    rangeEl.textContent = `Plage : ${Math.round(scoreData.tempoRange[0])}–${Math.round(scoreData.tempoRange[1])} BPM`;
    rangeEl.style.display = 'block';
  }

  infoDiv.style.display = 'block';
}

/* ═══════════════════════════════════════════════════════════════════════════
   V2 — Slider de tempo post-transcription
   ═══════════════════════════════════════════════════════════════════════════ */
let _originalTempo = 120;

function initTempoSlider(detectedTempo) {
  const panel = document.getElementById('tempo-adjust-panel');
  const slider = document.getElementById('tempo-slider');
  const output = document.getElementById('tempo-slider-output');
  const reset = document.getElementById('tempo-slider-reset');
  if (!panel || !slider) return;

  _originalTempo = detectedTempo;
  slider.value = detectedTempo;
  if (output) output.textContent = `${detectedTempo} BPM`;
  panel.style.display = 'block';

  const newSlider = slider.cloneNode(true);
  slider.parentNode.replaceChild(newSlider, slider);
  const newReset = reset ? reset.cloneNode(true) : null;
  if (reset && newReset) reset.parentNode.replaceChild(newReset, reset);

  newSlider.addEventListener('input', () => {
    const newTempo = parseInt(newSlider.value);
    const out = document.getElementById('tempo-slider-output');
    if (out) out.textContent = `${newTempo} BPM`;
    const bpmEl = document.getElementById('tempo-detected-value');
    if (bpmEl) bpmEl.textContent = `${newTempo} BPM`;
  });

  newSlider.addEventListener('change', () => {
    const oldTempo = (editor && editor.scoreData) ? (editor.scoreData.tempo || 120) : 120;
    const newTempo = parseInt(newSlider.value);

    if (window.currentScoreData) window.currentScoreData.tempo = newTempo;
    if (editor && editor.scoreData) editor.scoreData.tempo = newTempo;
    if (player) player._scoreData = editor.getScoreData();

    if (player && player.isPlaying) {
      let elapsed;
      if (player.isPaused) elapsed = player._pauseTime;
      else elapsed = player.audioCtx.currentTime - player._startTime;
      const currentBeat = elapsed * (oldTempo / 60.0);
      const newElapsed = currentBeat * (60.0 / newTempo);

      player._events = player._buildEvents(player._scoreData);
      player._totalTime = Math.max(...player._events.map(e => e.time + e.duration)) + 0.5;

      if (player.isPaused) {
        player._pauseTime = newElapsed;
      } else {
        player._stopAllSound();
        player._scheduledNoteKeys = new Set();
        player._startTime = player.audioCtx.currentTime - newElapsed;
        player._scheduleNotes(newElapsed);
      }
    }

    if (typeof window.rerenderScore === 'function') {
      window.rerenderScore(window.currentScoreData || (editor && editor.scoreData));
    }
  });

  if (newReset) {
    newReset.addEventListener('click', () => {
      newSlider.value = _originalTempo;
      const out = document.getElementById('tempo-slider-output');
      if (out) out.textContent = `${_originalTempo} BPM`;
      newSlider.dispatchEvent(new Event('input'));
    });
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   V2 — Affichage de la mesure auto-détectée
   ═══════════════════════════════════════════════════════════════════════════ */
function updateDetectedMeter(detectedMeter) {
  const [num, den] = detectedMeter;

  const timeSigSelect = document.getElementById('time-sig');
  const badge = document.getElementById('meter-auto-badge');
  const detectMeterCb = document.getElementById('detect-meter');

  if (!timeSigSelect) return;

  const targetVal = `${num}/${den}`;

  const hasOption = Array.from(timeSigSelect.options)
      .some(o => o.value === targetVal);

  if (!hasOption) return;

  // Détection désactivée : ne rien modifier
  if (!detectMeterCb?.checked) {
      if (badge) badge.style.display = 'none';
      return;
  }

  // L'utilisateur a choisi une mesure manuellement : respecter son choix
  if (timeSigSelect.dataset.userOverride === 'true') {
      if (badge) badge.style.display = 'none';
      return;
  }

  timeSigSelect.value = targetVal;

  if (badge) badge.style.display = 'inline';
}

/* ═══════════════════════════════════════════════════════════════════════════
   V2 — Affichage des avertissements de transcription
   ═══════════════════════════════════════════════════════════════════════════ */
function displayWarnings(warnings) {
  const panel = document.getElementById('transcription-warnings');
  const list = document.getElementById('warnings-list');
  if (!panel || !list) return;

  if (!warnings || warnings.length === 0) { panel.style.display = 'none'; return; }

  list.innerHTML = '';
  warnings.forEach(msg => {
    const li = document.createElement('li');
    li.textContent = msg;
    list.appendChild(li);
  });
  panel.style.display = 'block';
}

/* ═══════════════════════════════════════════════════════════════════════════
   Barre d'outils
   ═══════════════════════════════════════════════════════════════════════════ */
function initToolbar() {
  document.getElementById('btn-up')?.addEventListener('click', () => editor.transposeSelected(1));
  document.getElementById('btn-down')?.addEventListener('click', () => editor.transposeSelected(-1));
  document.getElementById('btn-enharmonic')?.addEventListener('click', () => editor.toggleEnharmonic());

  document.querySelectorAll('.dur-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      editor.setDurationSelected(btn.dataset.dur);
      document.querySelectorAll('.dur-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  document.getElementById('btn-dot')?.addEventListener('click', () => editor.toggleDotSelected());

  document.getElementById('btn-hand-r')?.addEventListener('click', () => {
    editor.assignHandSelected('treble');
    showToast('Note déplacée → main droite (Sol)', 'info');
  });
  document.getElementById('btn-hand-l')?.addEventListener('click', () => {
    editor.assignHandSelected('bass');
    showToast('Note déplacée → main gauche (Fa)', 'info');
  });

  document.getElementById('btn-add-note')?.addEventListener('click', () => editor.insertNoteAfterSelected(false));
  document.getElementById('btn-add-rest')?.addEventListener('click', () => editor.insertNoteAfterSelected(true));
  document.getElementById('btn-delete')?.addEventListener('click', () => editor.deleteSelected());
  document.getElementById('btn-undo')?.addEventListener('click', () => editor.undo());
  document.getElementById('btn-redo')?.addEventListener('click', () => editor.redo());

  const keySigToolbar = document.getElementById('key-sig-toolbar');
  if (keySigToolbar) {
    keySigToolbar.addEventListener('change', () => {
      editor.setKeySignature(keySigToolbar.value);
      showToast(`🎼 Armure changée : ${keySigToolbar.value}`, 'info', 2500);
    });
  }

  document.getElementById('btn-shift-left')?.addEventListener('click', () => editor.shiftNoteTime(-1));
  document.getElementById('btn-shift-right')?.addEventListener('click', () => editor.shiftNoteTime(+1));

  if (typeof renderer !== 'undefined' && renderer && typeof renderer.enableDragDrop === 'function') {
    renderer.enableDragDrop(editor);
  }

  document.getElementById('btn-export-pdf')?.addEventListener('click', exportPdf);
  document.getElementById('btn-export-midi')?.addEventListener('click', exportMidi);
  document.getElementById('btn-export-xml')?.addEventListener('click', exportXml);

  player = new ScorePlayer(renderer);
  document.getElementById('btn-play-pause')?.addEventListener('click', () => {
    const scoreData = editor.getScoreData();
    if (!scoreData) { showToast('Aucune partition à lire.', 'error'); return; }
    player.togglePlayPause(scoreData);
  });

  if (typeof renderer !== 'undefined' && renderer) {
    renderer.onNoteRightClick(async (noteId, info) => {
      if (!info || !info.noteData) return;
      const scoreData = editor.getScoreData();
      if (!scoreData) return;
      
      const tempo = scoreData.tempo || 120;
      const secondsPerBeat = 60.0 / tempo;
      const startTime = info.noteData.startBeat * secondsPerBeat;
      
      // Ensure player is ready
      player.preparePlayback(scoreData);

      
      if (player._totalTime > 0) {
        const pct = startTime / player._totalTime;
        player.seekTo(pct);
        if (!player.isPlaying) {
          await player.play();
        }
      }
    });
  }

  const timeline = document.getElementById('playback-timeline');
  if (timeline) {
    timeline.addEventListener('click', (e) => {
      const rect = timeline.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      player.seekTo(pct);
    });
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Export MIDI
   ═══════════════════════════════════════════════════════════════════════════ */
async function exportMidi() {
  const scoreData = editor.getScoreData();
  if (!scoreData) { showToast('⚠️ Aucune partition à exporter.', 'error'); return; }

  showToast('🎵 Génération du MIDI en cours…', 'info');

  try {
    const response = await fetch('/api/export-midi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scoreData),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Erreur HTTP ${response.status}`);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'partition_piano.mid';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast('✅ Fichier MIDI téléchargé !', 'success');
  } catch (err) {
    showToast(`❌ Erreur export MIDI : ${err.message}`, 'error', 6000);
    console.error('[MIDI Export]', err);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Export PDF
   ═══════════════════════════════════════════════════════════════════════════ */
function exportPdf() {
  const scoreData = editor ? editor.getScoreData() : null;
  if (!scoreData || !scoreData.measures || scoreData.measures.length === 0) {
    showToast('⚠️ Aucune partition à exporter.', 'error');
    return;
  }

  showToast('🖨️ Préparation du PDF…', 'info');

  const PDF_MPR = 5;
  const RENDER_W = PDF_MPR * ScoreRenderer.STAVE_W + ScoreRenderer.FIRST_EXTRA + ScoreRenderer.MARGIN_X * 2;
  const SVG_H = ScoreRenderer.ROW_HEIGHT + ScoreRenderer.MARGIN_Y * 2 + 30;
  const numRows = Math.ceil(scoreData.measures.length / PDF_MPR);
  const rowSvgStrings = [];

  const [tsNum, tsDen] = scoreData.timeSignature || [4, 4];
  const emptyMeasure = {
    treble: [{ id: '__pad_t__', keys: ['d/5'], durationStr: 'w', dots: 0, isRest: true, startBeat: 0, duration: 4, midiPitch: null, hand: 'treble', amplitude: 0 }],
    bass: [{ id: '__pad_b__', keys: ['f/3'], durationStr: 'w', dots: 0, isRest: true, startBeat: 0, duration: 4, midiPitch: null, hand: 'bass', amplitude: 0 }],
  };

  for (let row = 0; row < numRows; row++) {
    const rowMeasures = scoreData.measures.slice(row * PDF_MPR, (row + 1) * PDF_MPR);
    const paddedMeasures = rowMeasures.slice();
    while (paddedMeasures.length < PDF_MPR) paddedMeasures.push(emptyMeasure);

    const rowScoreData = Object.assign({}, scoreData, { measures: paddedMeasures, totalMeasures: paddedMeasures.length });

    const div = document.createElement('div');
    div.id = '__pdf_row_' + row + '__';
    div.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;visibility:hidden;';
    document.body.appendChild(div);

    const rowRenderer = new ScoreRenderer(div.id);
    rowRenderer._forcedMPR = PDF_MPR;

    // Transmettre l'état des options d'affichage au rowRenderer PDF
    if (typeof renderer !== 'undefined' && renderer) {
      rowRenderer.showPedals = renderer.showPedals;
      rowRenderer.showChordSymbols = renderer.showChordSymbols;
      rowRenderer.showHighestNote = renderer.showHighestNote;
    }

    rowRenderer.render(rowScoreData);
    if (rowRenderer.showHighestNote && typeof rowRenderer.renderHighestNoteLabels === 'function') {
      rowRenderer.renderHighestNoteLabels();
    }

    const svgEl = div.querySelector('svg');
    if (svgEl) {
      svgEl.setAttribute('viewBox', '0 0 ' + RENDER_W + ' ' + SVG_H);
      svgEl.setAttribute('width', RENDER_W);
      svgEl.removeAttribute('height');
      svgEl.setAttribute('preserveAspectRatio', 'xMinYMin meet');
      svgEl.style.cssText = 'display:block;width:100%;height:auto;';
      rowSvgStrings.push(svgEl.outerHTML);
    }
    document.body.removeChild(div);
  }

  const rowSvgsHtml = rowSvgStrings.map(svg => '<div class="score-row">' + svg + '</div>').join('\n');
  const meta = `Tempo : ${scoreData.tempo} BPM · ${scoreData.timeSignature[0]}/${scoreData.timeSignature[1]} · Tonalité : ${scoreData.keySignature || 'C'} · ${scoreData.totalMeasures} mesure(s)`;

  const printWindow = window.open('', '_blank', 'width=900,height=1200');
  if (!printWindow) {
    showToast('❌ Fenêtre bloquée par le navigateur. Autorisez les popups.', 'error', 6000);
    return;
  }

  printWindow.document.write(`<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"/><title>AudioScore — Partition Piano</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
@page{size:A4 portrait;margin:12mm 12mm}
body{background:#fff;font-family:Georgia,serif;color:#111;padding:4mm 6mm}
h1{font-size:14pt;text-align:center;margin-bottom:2mm;letter-spacing:.04em}
.meta{text-align:center;font-size:8pt;color:#555;margin-bottom:3mm}
.score-wrap{width:100%}
.score-row{display:block;width:100%;break-inside:avoid;page-break-inside:avoid;margin-bottom:0}
.score-row svg{display:block;width:100%!important;height:auto!important}
@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>
<h1>🎹 Partition Piano — AudioScore</h1>
<p class="meta">${meta}</p>
<div class="score-wrap">${rowSvgsHtml}</div>
<script>window.onload=function(){setTimeout(function(){window.print();window.close()},600)};<\/script>
</body></html>`);
  printWindow.document.close();
}

/* ═══════════════════════════════════════════════════════════════════════════
   Export MusicXML
   ═══════════════════════════════════════════════════════════════════════════ */
async function exportXml() {
  const scoreData = editor.getScoreData();
  if (!scoreData) { showToast('⚠️ Aucune partition à exporter.', 'error'); return; }

  showToast('🎼 Génération du MusicXML en cours…', 'info');

  try {
    const response = await fetch('/api/export-musicxml', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scoreData),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Erreur HTTP ${response.status}`);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'partition_piano.musicxml';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast('✅ Fichier MusicXML téléchargé !', 'success');
  } catch (err) {
    showToast(`❌ Erreur export MusicXML : ${err.message}`, 'error', 6000);
    console.error('[MusicXML Export]', err);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Raccourcis clavier
   ═══════════════════════════════════════════════════════════════════════════ */
function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    const section = getVisibleSection();
    if (section !== 'score') return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

    switch (true) {
      case e.key === 'ArrowUp': e.preventDefault(); editor.transposeSelected(1); break;
      case e.key === 'ArrowDown': e.preventDefault(); editor.transposeSelected(-1); break;
      case e.ctrlKey && e.key === 'ArrowRight': e.preventDefault(); editor.shiftNoteTime(+1); break;
      case e.ctrlKey && e.key === 'ArrowLeft': e.preventDefault(); editor.shiftNoteTime(-1); break;
      case e.key === 'ArrowRight' && !e.ctrlKey: e.preventDefault(); editor.selectNextNote(); break;
      case e.key === 'ArrowLeft' && !e.ctrlKey: e.preventDefault(); editor.selectPrevNote(); break;
      case e.key === ' ': e.preventDefault(); if (player) { const sd = editor.getScoreData(); if (sd) player.togglePlayPause(sd); } break;
      case e.key === 'Delete' || e.key === 'Backspace': e.preventDefault(); editor.deleteSelected(); break;
      case (e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey: e.preventDefault(); editor.undo(); break;
      case (e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey)): e.preventDefault(); editor.redo(); break;
      case (e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C'): e.preventDefault(); editor.copySelected(); break;
      case (e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V'): e.preventDefault(); editor.pasteAfterSelected(); break;
      case e.key === 'w' || e.key === 'W': editor.setDurationSelected('w'); break;
      case e.key === 'h' || e.key === 'H': editor.setDurationSelected('h'); break;
      case e.key === 'q' || e.key === 'Q': editor.setDurationSelected('q'); break;
      case e.key === '8': editor.setDurationSelected('8'); break;
      case e.key === '6': editor.setDurationSelected('16'); break;
      case e.key === '.': editor.toggleDotSelected(); break;
      case e.key === 'Escape': editor.clearSelection(); if (player && player.isPlaying) player.stop(); break;
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Gestion des sections
   ═══════════════════════════════════════════════════════════════════════════ */
function showSection(name) {
  document.getElementById('upload-section')?.classList.toggle('hidden', name !== 'upload');
  document.getElementById('loading-section')?.classList.toggle('hidden', name !== 'loading');
  document.getElementById('score-section')?.classList.toggle('hidden', name !== 'score');
}

function getVisibleSection() {
  if (!document.getElementById('score-section')?.classList.contains('hidden')) return 'score';
  if (!document.getElementById('loading-section')?.classList.contains('hidden')) return 'loading';
  return 'upload';
}

/* ═══════════════════════════════════════════════════════════════════════════
   Utilitaires
   ═══════════════════════════════════════════════════════════════════════════ */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

/* ═══════════════════════════════════════════════════════════════════════════
   Toasts (notifications)
   ═══════════════════════════════════════════════════════════════════════════ */
function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('show'));

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px) scale(0.95)';
    toast.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}