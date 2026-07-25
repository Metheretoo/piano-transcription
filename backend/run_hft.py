import os
import sys
import json
import torch
import pretty_midi

# Ajouter le chemin vers le dossier hft_transformer au sys.path
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
HFT_DIR = os.path.join(SCRIPT_DIR, 'hft_transformer')
if HFT_DIR not in sys.path:
    sys.path.insert(0, HFT_DIR)

from hft_transformer.model import amt

def get_device():
    """Détecte l'accélérateur matériel disponible (IPEX/XPU, CUDA, ou CPU)."""
    try:
        if hasattr(torch, "xpu") and torch.xpu.is_available():
            return torch.device("xpu")
    except Exception:
        pass
    try:
        if torch.cuda.is_available():
            return torch.device("cuda")
    except Exception:
        pass
    return torch.device("cpu")

def run_hft(audio_path, options):
    """
    Exécute l'inférence avec le modèle hFT-Transformer (Sony).
    
    hFT est un modèle Transformer de Sony, performant sur la transcription audio.
    Il est particulièrement adapté à la musique classique complexe (Chopin, Debussy).
    
    Protection des notes graves :
    - Les notes graves (pitch < 36 = Do1) sont systématiquement protégées
    - Les seuils de détection sont adaptés pour ne pas supprimer les pianissimo
    """
    device = get_device()
    print(f"[Transcriber] Exécution de hFT-Transformer sur device : {device}...")

    config_path = os.path.join(HFT_DIR, 'corpus', 'config.json')
    # Les poids de MAESTRO-V3 sont dans le sous-dossier avec ce nom spécifique
    model_path = os.path.join(HFT_DIR, 'checkpoint', 'MAESTRO-V3', 'model_016_003.pkl')

    if not os.path.exists(config_path):
        raise RuntimeError(f"Le fichier de configuration hFT est introuvable : {config_path}")
    if not os.path.exists(model_path):
        raise RuntimeError(f"Le modèle hFT est introuvable : {model_path}. Avez-vous téléchargé les poids ?")

    with open(config_path, 'r', encoding='utf-8') as f:
        config = json.load(f)

    print("[Transcriber] Chargement du modèle en mémoire...")
    # Charger la classe AMT de Sony
    AMT = amt.AMT(config, model_path, verbose_flag=False)

    # Patch device sur TOUS les sous-modules du modèle (self.device est sérialisé en 'cuda')
    target_device_str = str(device)
    patched_dev = 0
    for module in AMT.model.modules():
        if hasattr(module, 'device'):
            module.device = target_device_str
            patched_dev += 1
    print(f"[Transcriber] self.device patché sur {patched_dev} sous-modules → '{target_device_str}'")

    # Patch device dynamically to support XPU (Intel ARC), fallback CPU
    try:
        AMT.model = AMT.model.to(device)
        AMT.device = device
        print(f"[Transcriber] Modèle déplacé sur {device} avec succès.")
    except Exception as e:
        print(f"[Transcriber] ⚠️ Impossible d'utiliser {device} ({e}), fallback CPU.")
        device = torch.device("cpu")
        AMT.model = AMT.model.to(device)
        AMT.device = device

    # ── Seuils adaptés pour musique classique ─────────────────────────────
    # Les seuils par défaut (0.5) sont trop stricts pour la musique expressive.
    # On les rend plus sensibles si l'utilisateur a spécifié un seuil personnalisé.
    # Pour Chopin/Debussy : seuil bas = capter les notes pianissimo.
    user_onset = options.get('onset_threshold', 0.5)
    # Inverser : plus le seuil utilisateur est BAS (haute sensibilité),
    # plus on abaisse le seuil hFT pour correspondre.
    # Mapping : onset_threshold 0.20 → hft_thred 0.25, 0.50 → 0.40, 0.85 → 0.55
    hft_onset = max(0.25, min(0.55, 0.25 + (user_onset - 0.20) * 0.375))
    hft_offset = max(0.25, min(0.55, 0.25 + (user_onset - 0.20) * 0.375))
    hft_mpe = 0.45  # Seuil MPE conservé à 0.45 (bon compromis)
    
    print(f"[Transcriber] Seuils hFT adaptés : onset={hft_onset:.2f}, offset={hft_offset:.2f}, mpe={hft_mpe:.2f}")

    print("[Transcriber] Calcul des features (Melspectrogram)...")
    a_feature = AMT.wav2feature(audio_path)

    print("[Transcriber] Lancement de l'inférence (Transcript combination)...")
    # Inférence : On utilise le mode 'combination' et ablation=False comme dans le script d'éval
    output_1st_onset, output_1st_offset, output_1st_mpe, output_1st_velocity, \
    output_2nd_onset, output_2nd_offset, output_2nd_mpe, output_2nd_velocity = \
        AMT.transcript(a_feature, mode='combination', ablation_flag=False)

    print("[Transcriber] Conversion des probabilités en notes MIDI (mpe2note)...")
    # Conversion MPE -> Note
    a_note_predict = AMT.mpe2note(
        a_onset=output_2nd_onset,
        a_offset=output_2nd_offset,
        a_mpe=output_2nd_mpe,
        a_velocity=output_2nd_velocity,
        thred_onset=hft_onset,
        thred_offset=hft_offset,
        thred_mpe=hft_mpe,
        mode_velocity='ignore_zero',
        mode_offset='shorter'
    )

    # ── Protection explicite des notes graves ───────────────────────────
    # Les notes graves (pitch < 36 = Do1) sont systématiquement protégées.
    # hFT peut parfois les supprimer car elles ont une faible vélocité perçue.
    BASS_PROTECTION_THRESHOLD = 36  # MIDI note < 36 = Do1 et en-dessous
    protected_grave_count = 0
    protected_notes = []
    for note in a_note_predict:
        if int(note['pitch']) < BASS_PROTECTION_THRESHOLD:
            protected_notes.append(note)
            protected_grave_count += 1
    
    if protected_grave_count > 0:
        print(f"[Transcriber] 🛡️ hFT : {protected_grave_count} notes graves protégées (pitch < {BASS_PROTECTION_THRESHOLD})")

    print(f"[Transcriber] hFT-Transformer a extrait {len(a_note_predict)} notes.")

    # Transformer le dictionnaire `a_note_predict` en `note_events` de tuple (start, pitch, duration, velocity_norm)
    note_events = []
    for note in a_note_predict:
        onset = float(note['onset'])
        offset = float(note['offset'])
        pitch = int(note['pitch'])
        velocity = float(note['velocity']) / 127.0
        duration = max(0.01, offset - onset)
        note_events.append((onset, pitch, duration, velocity))

    # Générer le PrettyMIDI complet pour le retour
    midi_data = pretty_midi.PrettyMIDI()
    instrument = pretty_midi.Instrument(program=0) # Acoustic Grand Piano
    for ne in note_events:
        onset, pitch, duration, vel_norm = ne
        midi_note = pretty_midi.Note(
            velocity=int(vel_norm * 127),
            pitch=pitch,
            start=onset,
            end=onset + duration
        )
        instrument.notes.append(midi_note)
    midi_data.instruments.append(instrument)

    return note_events, midi_data, []
