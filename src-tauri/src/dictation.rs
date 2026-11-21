//! Dictée vocale 100 % locale, comme l'appli Handy : on enregistre le micro (crate `cpal`),
//! puis whisper.cpp (crate `whisper-rs`, accéléré par Metal) transcrit le son sur le Mac.
//! Rien ne part sur Internet, sauf le téléchargement du modèle : une seule fois, depuis une
//! adresse Hugging Face figée, avec vérification de la taille et de l'empreinte SHA-256.
//!
//! Déroulé vu de l'interface :
//!  - `start_dictation` ouvre le micro et envoie le niveau sonore (pour l'animation) via un `Channel` ;
//!  - pendant que tu parles, un second fil retranscrit le passage en cours environ chaque seconde
//!    et envoie le texte provisoire (`Partial`). Whisper ne sait pas transcrire « au fil de l'eau » :
//!    on découpe donc le son en morceaux, figés à chaque pause (ou au bout de 24 s) ;
//!  - `stop_dictation` coupe le micro, transcrit le dernier morceau et renvoie le texte complet ;
//!  - `cancel_dictation` coupe le micro et jette le son.

use cpal::{
    SampleFormat, SizedSample,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State, ipc::Channel};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

// --- Catalogue des modèles (figé : l'interface ne choisit qu'un identifiant) -----------------

pub struct Model {
    pub id: &'static str,
    name: &'static str,
    description: &'static str,
    file: &'static str,
    sha256: &'static str,
    size: u64,
}

/// Empreintes et tailles lues dans les pointeurs Git LFS du dépôt ggerganov/whisper.cpp.
pub const MODELS: &[Model] = &[
    Model {
        id: "small",
        name: "Rapide",
        description: "Whisper Small : léger et rapide, correct en français.",
        file: "ggml-small-q5_1.bin",
        sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
        size: 190_085_487,
    },
    Model {
        id: "turbo",
        name: "Précis",
        description: "Whisper Large v3 Turbo : bien meilleur en français, un peu plus lent.",
        file: "ggml-large-v3-turbo-q5_0.bin",
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
        size: 574_041_195,
    },
];

const DOWNLOAD_BASE: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

/// Langues proposées dans les Paramètres (« auto » = Whisper devine).
const LANGUAGES: &[&str] = &["auto", "fr", "en", "es", "de", "it", "pt", "nl"];

/// Whisper travaille en 16 kHz mono.
const WHISPER_RATE: u32 = 16_000;
/// Au-delà, on arrête d'enregistrer (10 minutes ≈ 115 Mo de son en 48 kHz).
const MAX_RECORDING: Duration = Duration::from_secs(10 * 60);
/// Plus court que ça, c'est un clic par erreur : on ne transcrit pas.
const MIN_SECONDS: f32 = 0.4;
/// Sous ce niveau, le son est vide : en général, macOS a refusé l'accès au micro.
const SILENCE_PEAK: f32 = 0.002;
/// Transcription en direct : un passage toutes les 0,4 s au plus, s'il y a au moins 0,5 s de son nouveau.
const LIVE_INTERVAL: Duration = Duration::from_millis(400);
const LIVE_MIN_NEW: f32 = 0.5;
/// Un morceau est figé après une pause (fin silencieuse) s'il dure au moins 3 s, et d'office à 24 s
/// (Whisper travaille par fenêtres de 30 s).
const CHUNK_MIN_SECONDS: f32 = 3.0;
const CHUNK_MAX_SECONDS: f32 = 24.0;
const PAUSE_SECONDS: f32 = 0.6;
const PAUSE_RMS: f32 = 0.01;
/// Fin du texte déjà figé, donnée à Whisper pour qu'il continue la phrase (ponctuation, majuscules).
const PROMPT_CHARS: usize = 200;

pub fn find_model(id: &str) -> Result<&'static Model, String> {
    MODELS.iter().find(|m| m.id == id).ok_or_else(|| "Modèle de dictée inconnu.".to_string())
}

pub fn check_language(language: &str) -> Result<&'static str, String> {
    LANGUAGES.iter().copied().find(|l| *l == language).ok_or_else(|| "Langue de dictée inconnue.".to_string())
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("dictation-models"))
        .map_err(|e| format!("Dossier de l'appli introuvable : {e}"))
}

fn model_path(app: &AppHandle, model: &Model) -> Result<PathBuf, String> {
    Ok(models_dir(app)?.join(model.file))
}

// --- État partagé ------------------------------------------------------------------------

type CachedContext = Option<(&'static str, Arc<WhisperContext>)>;

#[derive(Default)]
pub struct Dictation {
    recording: Mutex<Option<Recording>>,
    /// Le dernier modèle chargé (le charger prend une seconde ou deux) : gardé pour les dictées suivantes.
    context: Arc<Mutex<CachedContext>>,
    /// Téléchargement en cours : identifiant du modèle + drapeau d'annulation.
    download: Mutex<Option<(&'static str, Arc<AtomicBool>)>>,
}

struct Recording {
    stop: mpsc::Sender<()>,
    thread: thread::JoinHandle<Result<(), String>>,
    live: thread::JoinHandle<Progress>,
    shared: Arc<Shared>,
    model: &'static Model,
    language: &'static str,
}

/// Partagé entre le micro, la transcription en direct et `stop_dictation`.
#[derive(Default)]
struct Shared {
    /// Son enregistré, déjà en mono, à la fréquence du micro.
    buffer: Mutex<Vec<f32>>,
    rate: AtomicU32,
    /// false = dictée terminée ou annulée : la transcription en direct s'arrête (même en plein calcul).
    running: AtomicBool,
}

/// Ce que la transcription en direct a déjà figé.
#[derive(Default)]
struct Progress {
    text: String,
    /// Position (dans `buffer`) de la fin du dernier morceau figé.
    at: usize,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DictationEvent {
    /// Niveau du son (0 à 1) depuis le dernier envoi, environ 16 fois par seconde.
    Level { level: f32 },
    /// Durée maximale atteinte : le micro n'enregistre plus, l'interface doit appeler stop.
    Limit,
    /// Texte provisoire : `committed` est figé, `pending` peut encore changer.
    Partial { committed: String, pending: String },
}

// --- Micro ---------------------------------------------------------------------------------

/// Tourne dans son propre fil : le flux audio de macOS doit rester là où il a été créé.
fn record(
    ready: mpsc::Sender<Result<(), String>>,
    stop: mpsc::Receiver<()>,
    shared: Arc<Shared>,
    on_event: Channel<DictationEvent>,
) -> Result<(), String> {
    let fail = |message: String| {
        let _ = ready.send(Err(message.clone()));
        Err(message)
    };

    let host = cpal::default_host();
    let Some(device) = host.default_input_device() else {
        return fail("Aucun micro trouvé. Branche-en un ou choisis-le dans Réglages Système › Son.".into());
    };
    let config = match device.default_input_config() {
        Ok(c) => c,
        Err(e) => return fail(format!("Impossible d'utiliser le micro : {e}")),
    };
    let rate = config.sample_rate();
    shared.rate.store(rate, Ordering::Relaxed);
    let peak = Arc::new(AtomicU32::new(0));
    let max_samples = rate as usize * MAX_RECORDING.as_secs() as usize;

    let (b, p) = (shared.clone(), peak.clone());
    let stream_config = config.config();
    let stream = match config.sample_format() {
        SampleFormat::F32 => build_stream::<f32>(&device, stream_config, b, p, max_samples),
        SampleFormat::I16 => build_stream::<i16>(&device, stream_config, b, p, max_samples),
        SampleFormat::I32 => build_stream::<i32>(&device, stream_config, b, p, max_samples),
        SampleFormat::U16 => build_stream::<u16>(&device, stream_config, b, p, max_samples),
        other => return fail(format!("Format de micro non géré : {other}")),
    };
    let stream = match stream {
        Ok(s) => s,
        Err(e) => return fail(format!("Impossible d'ouvrir le micro : {e}")),
    };
    if let Err(e) = stream.play() {
        return fail(format!("Impossible de démarrer le micro : {e}"));
    }
    let _ = ready.send(Ok(()));

    let started = Instant::now();
    let mut limit_sent = false;
    loop {
        match stop.recv_timeout(Duration::from_millis(60)) {
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            _ => break, // arrêt demandé, ou plus personne pour le demander
        }
        let level = f32::from_bits(peak.swap(0, Ordering::Relaxed)).min(1.0);
        let _ = on_event.send(DictationEvent::Level { level });
        if !limit_sent && started.elapsed() >= MAX_RECORDING {
            limit_sent = true;
            let _ = on_event.send(DictationEvent::Limit);
        }
        // Filet de sécurité si l'interface a disparu sans arrêter la dictée.
        if started.elapsed() >= MAX_RECORDING + Duration::from_secs(120) {
            break;
        }
    }
    drop(stream); // libère le micro (le voyant orange de macOS s'éteint)
    Ok(())
}

fn build_stream<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    shared: Arc<Shared>,
    peak: Arc<AtomicU32>,
    max_samples: usize,
) -> Result<cpal::Stream, cpal::Error>
where
    T: SizedSample,
    f32: cpal::FromSample<T>,
{
    let channels = (config.channels as usize).max(1);
    device.build_input_stream::<T, _, _>(
        config,
        move |data: &[T], _| {
            let Ok(mut buf) = shared.buffer.lock() else { return };
            if buf.len() >= max_samples {
                return;
            }
            let mut local_peak = 0f32;
            for frame in data.chunks(channels) {
                // Stéréo → mono : moyenne des canaux.
                let sample = frame.iter().map(|s| s.to_sample::<f32>()).sum::<f32>() / channels as f32;
                local_peak = local_peak.max(sample.abs());
                buf.push(sample);
            }
            // Pour des flottants positifs, l'ordre des bits suit l'ordre des valeurs : fetch_max marche.
            peak.fetch_max(local_peak.to_bits(), Ordering::Relaxed);
        },
        |e| eprintln!("micro : {e}"),
        None,
    )
}

/// Passe le son à 16 kHz. En réduisant, on fait la moyenne de chaque tranche (filtre simple qui
/// évite les sifflements) ; en augmentant (micro 8 kHz), interpolation linéaire.
pub fn resample(input: &[f32], from: u32) -> Vec<f32> {
    if from == WHISPER_RATE || input.is_empty() || from == 0 {
        return input.to_vec();
    }
    let ratio = from as f64 / WHISPER_RATE as f64;
    let out_len = (input.len() as f64 / ratio).floor() as usize;
    (0..out_len)
        .map(|i| {
            let pos = i as f64 * ratio;
            if ratio > 1.0 {
                let start = pos as usize;
                let end = (((i + 1) as f64 * ratio) as usize).clamp(start + 1, input.len());
                input[start..end].iter().sum::<f32>() / (end - start) as f32
            } else {
                let index = pos as usize;
                let frac = (pos - index as f64) as f32;
                let a = input[index];
                let b = *input.get(index + 1).unwrap_or(&a);
                a + (b - a) * frac
            }
        })
        .collect()
}

// --- Transcription -------------------------------------------------------------------------

fn load_context(app: &AppHandle, cache: &Mutex<CachedContext>, model: &'static Model) -> Result<Arc<WhisperContext>, String> {
    // Le verrou reste pris pendant le chargement : un « stop » attend le préchargement au lieu de recharger.
    let mut guard = cache.lock().map_err(|_| "Modèle de dictée inutilisable.")?;
    if let Some((id, ctx)) = guard.as_ref()
        && *id == model.id
    {
        return Ok(ctx.clone());
    }
    *guard = None; // libère l'ancien modèle avant d'en charger un autre (mémoire)
    let path = model_path(app, model)?;
    if !path.is_file() {
        return Err(format!("Le modèle « {} » n'est pas téléchargé : va dans Paramètres › Dictée.", model.name));
    }
    let ctx = WhisperContext::new_with_params(&path, WhisperContextParameters::default())
        .map_err(|e| format!("Impossible de charger le modèle de dictée : {e}"))?;
    let ctx = Arc::new(ctx);
    *guard = Some((model.id, ctx.clone()));
    Ok(ctx)
}

/// Transcrit un morceau (déjà en 16 kHz). `prompt` = texte qui le précède ; `running` passé à false
/// interrompt le calcul (dictée terminée pendant un passage en direct).
fn transcribe(ctx: &WhisperContext, audio: &[f32], language: &str, prompt: &str, running: Option<Arc<Shared>>) -> Result<String, String> {
    let mut state = ctx.create_state().map_err(|e| format!("Transcription impossible : {e}"))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some(language));
    if !prompt.is_empty() {
        params.set_initial_prompt(&prompt.replace('\0', ""));
    }
    if let Some(shared) = running {
        params.set_abort_callback_safe(move || !shared.running.load(Ordering::Relaxed));
    }
    params.set_translate(false);
    params.set_no_context(true);
    params.set_suppress_blank(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    let threads = thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8);
    params.set_n_threads(threads as i32);

    state.full(params, audio).map_err(|e| format!("Transcription impossible : {e}"))?;
    let segments = state
        .as_iter()
        .map(|segment| segment.to_str_lossy().map(|s| s.into_owned()).unwrap_or_default())
        .collect::<Vec<_>>();
    Ok(clean_segments(&segments))
}

/// Phrases que Whisper invente sur du silence (il a appris sur des vidéos sous-titrées).
const HALLUCINATIONS: &[&str] = &[
    "sous-titres realises par la communaute d'amara.org",
    "sous-titrage st' 501",
    "sous-titrage societe radio-canada",
    "merci d'avoir regarde cette video",
    "merci d'avoir regarde",
    "thank you for watching",
    "thanks for watching",
];

fn normalize(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|c| match c {
            'à' | 'â' | 'ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'î' | 'ï' => 'i',
            'ô' | 'ö' => 'o',
            'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            '’' => '\'',
            c => c,
        })
        .collect::<String>()
        .trim_matches(|c: char| c.is_whitespace() || matches!(c, '.' | '!' | '?' | '…'))
        .to_string()
}

/// Assemble les morceaux en retirant les bruits notés « [Musique] », « (rires) »… et les hallucinations.
pub fn clean_segments(segments: &[String]) -> String {
    segments
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .filter(|s| {
            let bracketed = |open: char, close: char| s.starts_with(open) && s.ends_with(close);
            !(bracketed('[', ']') || bracketed('(', ')') || bracketed('*', '*') || bracketed('♪', '♪'))
        })
        .filter(|s| {
            let n = normalize(s);
            !n.contains("amara.org") && !HALLUCINATIONS.contains(&n.as_str())
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Assemble deux bouts de texte avec une espace.
pub fn join_text(a: &str, b: &str) -> String {
    match (a.trim(), b.trim()) {
        ("", b) => b.to_string(),
        (a, "") => a.to_string(),
        (a, b) => format!("{a} {b}"),
    }
}

/// Les derniers caractères du texte (sans couper un caractère en deux).
fn prompt_tail(text: &str) -> &str {
    let count = text.chars().count();
    match text.char_indices().nth(count.saturating_sub(PROMPT_CHARS)) {
        Some((i, _)) => &text[i..],
        None => text,
    }
}

/// La fin du morceau est-elle silencieuse (tu as fait une pause) ?
pub fn ends_with_pause(samples: &[f32], rate: u32) -> bool {
    let n = (rate as f32 * PAUSE_SECONDS) as usize;
    if n == 0 || samples.len() < n {
        return false;
    }
    let tail = &samples[samples.len() - n..];
    (tail.iter().map(|s| s * s).sum::<f32>() / n as f32).sqrt() < PAUSE_RMS
}

/// Prépare un morceau pour Whisper : 16 kHz, au moins 1,25 s. None = rien à transcrire (silence).
fn prepare(samples: &[f32], rate: u32) -> Option<Vec<f32>> {
    if samples.iter().fold(0f32, |m, s| m.max(s.abs())) < SILENCE_PEAK {
        return None;
    }
    let mut out = resample(samples, rate);
    let min_len = WHISPER_RATE as usize * 5 / 4;
    if out.len() < min_len {
        out.resize(min_len, 0.0);
    }
    Some(out)
}

/// Transcription en direct, dans son propre fil, tant que la dictée continue.
fn live_transcription(
    app: AppHandle,
    cache: Arc<Mutex<CachedContext>>,
    model: &'static Model,
    language: &'static str,
    shared: Arc<Shared>,
    on_event: Channel<DictationEvent>,
) -> Progress {
    let mut progress = Progress::default();
    // Chargé pendant que tu commences à parler. En cas d'échec, stop_dictation affichera l'erreur.
    let Ok(ctx) = load_context(&app, &cache, model) else { return progress };
    let mut last_len = 0;
    while shared.running.load(Ordering::Relaxed) {
        thread::sleep(LIVE_INTERVAL);
        let rate = shared.rate.load(Ordering::Relaxed);
        if rate == 0 || !shared.running.load(Ordering::Relaxed) {
            continue;
        }
        let chunk = match shared.buffer.lock() {
            Ok(buf) => buf.get(progress.at..).unwrap_or_default().to_vec(),
            Err(_) => break,
        };
        if ((chunk.len() - last_len.min(chunk.len())) as f32) < rate as f32 * LIVE_MIN_NEW {
            continue;
        }
        let seconds = chunk.len() as f32 / rate as f32;
        let text = match prepare(&chunk, rate) {
            None => String::new(),
            Some(audio) => match transcribe(&ctx, &audio, language, prompt_tail(&progress.text), Some(shared.clone())) {
                Ok(text) => text,
                Err(_) => continue, // interrompu (fin de la dictée) ou raté : on réessaiera
            },
        };
        if !shared.running.load(Ordering::Relaxed) {
            break; // la dictée est finie pendant le calcul : stop_dictation s'occupe de la suite
        }
        let commit = seconds >= CHUNK_MAX_SECONDS || (seconds >= CHUNK_MIN_SECONDS && ends_with_pause(&chunk, rate));
        if commit {
            progress.text = join_text(&progress.text, &text);
            progress.at += chunk.len();
            last_len = 0;
            let _ = on_event.send(DictationEvent::Partial { committed: progress.text.clone(), pending: String::new() });
        } else {
            last_len = chunk.len();
            let _ = on_event.send(DictationEvent::Partial { committed: progress.text.clone(), pending: text });
        }
    }
    progress
}

// --- Commandes : état et modèles --------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    size: u64,
    installed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationStatus {
    models: Vec<ModelStatus>,
    /// Modèle en cours de téléchargement, s'il y en a un.
    downloading: Option<&'static str>,
}

#[tauri::command]
pub fn dictation_status(app: AppHandle, state: State<'_, Dictation>) -> Result<DictationStatus, String> {
    let models = MODELS
        .iter()
        .map(|m| ModelStatus {
            id: m.id,
            name: m.name,
            description: m.description,
            size: m.size,
            installed: model_path(&app, m).is_ok_and(|p| p.is_file()),
        })
        .collect();
    let downloading = state.download.lock().map_err(|_| "État illisible.")?.as_ref().map(|(id, _)| *id);
    Ok(DictationStatus { models, downloading })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    received: u64,
    total: u64,
}

/// Retire le téléchargement de l'état quand on sort de la fonction, quoi qu'il arrive.
struct DownloadGuard<'a>(&'a Mutex<Option<(&'static str, Arc<AtomicBool>)>>);
impl Drop for DownloadGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut d) = self.0.lock() {
            *d = None;
        }
    }
}

#[tauri::command]
pub async fn download_dictation_model(
    app: AppHandle,
    state: State<'_, Dictation>,
    id: String,
    on_progress: Channel<DownloadProgress>,
) -> Result<(), String> {
    let model = find_model(&id)?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut download = state.download.lock().map_err(|_| "État illisible.")?;
        if download.is_some() {
            return Err("Un téléchargement est déjà en cours.".into());
        }
        *download = Some((model.id, cancel.clone()));
    }
    let _guard = DownloadGuard(&state.download);

    let dir = models_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Impossible de créer le dossier des modèles : {e}"))?;
    let final_path = dir.join(model.file);
    let part_path = dir.join(format!("{}.part", model.file));

    let result = fetch_model(model, &part_path, &cancel, &on_progress).await;
    match result {
        Ok(()) => fs::rename(&part_path, &final_path).map_err(|e| format!("Impossible d'installer le modèle : {e}")),
        Err(e) => {
            let _ = fs::remove_file(&part_path);
            Err(e)
        }
    }
}

async fn fetch_model(model: &Model, part_path: &PathBuf, cancel: &AtomicBool, on_progress: &Channel<DownloadProgress>) -> Result<(), String> {
    // HTTPS obligatoire, y compris pour les redirections vers le CDN de Hugging Face.
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(format!("{DOWNLOAD_BASE}{}", model.file))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Téléchargement impossible (connexion à Internet ?) : {e}"))?;

    let mut file = fs::File::create(part_path).map_err(|e| format!("Impossible d'écrire le modèle : {e}"))?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut last_progress = Instant::now();
    let mut stream = futures_util::StreamExt::fuse(response.bytes_stream());
    while let Some(chunk) = futures_util::StreamExt::next(&mut stream).await {
        if cancel.load(Ordering::Relaxed) {
            return Err("Téléchargement annulé.".into());
        }
        let bytes = chunk.map_err(|e| format!("Téléchargement interrompu : {e}"))?;
        received += bytes.len() as u64;
        if received > model.size {
            return Err("Le fichier reçu est plus gros que prévu : téléchargement refusé.".into());
        }
        hasher.update(&bytes);
        file.write_all(&bytes).map_err(|e| format!("Impossible d'écrire le modèle (disque plein ?) : {e}"))?;
        if last_progress.elapsed() >= Duration::from_millis(200) {
            last_progress = Instant::now();
            let _ = on_progress.send(DownloadProgress { received, total: model.size });
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    let _ = on_progress.send(DownloadProgress { received, total: model.size });

    if received != model.size {
        return Err("Téléchargement incomplet : réessaie.".into());
    }
    let digest = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>();
    if digest != model.sha256 {
        return Err("Le fichier reçu ne correspond pas au modèle attendu (empreinte différente) : il a été supprimé.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn cancel_dictation_download(state: State<'_, Dictation>) -> Result<(), String> {
    if let Some((_, cancel)) = state.download.lock().map_err(|_| "État illisible.")?.as_ref() {
        cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub fn delete_dictation_model(app: AppHandle, state: State<'_, Dictation>, id: String) -> Result<(), String> {
    let model = find_model(&id)?;
    if let Ok(mut cache) = state.context.lock()
        && cache.as_ref().is_some_and(|(loaded, _)| *loaded == model.id)
    {
        *cache = None;
    }
    match fs::remove_file(model_path(&app, model)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Impossible de supprimer le modèle : {e}")),
    }
}

// --- Commandes : dictée --------------------------------------------------------------------

#[tauri::command]
pub async fn start_dictation(
    app: AppHandle,
    state: State<'_, Dictation>,
    model: String,
    language: String,
    on_event: Channel<DictationEvent>,
) -> Result<(), String> {
    let model = find_model(&model)?;
    let language = check_language(&language)?;
    if state.recording.lock().map_err(|_| "État illisible.")?.is_some() {
        return Err("Une dictée est déjà en cours.".into());
    }
    if !model_path(&app, model)?.is_file() {
        return Err(format!("Le modèle « {} » n'est pas téléchargé : va dans Paramètres › Dictée.", model.name));
    }

    let shared = Arc::new(Shared { running: AtomicBool::new(true), ..Default::default() });
    let (ready_tx, ready_rx) = mpsc::channel();
    let (stop_tx, stop_rx) = mpsc::channel();
    let (s, events) = (shared.clone(), on_event.clone());
    let handle = thread::spawn(move || record(ready_tx, stop_rx, s, events));
    let ready = tauri::async_runtime::spawn_blocking(move || ready_rx.recv_timeout(Duration::from_secs(10)))
        .await
        .map_err(|e| e.to_string())?;
    match ready {
        Ok(Ok(())) => {}
        Ok(Err(message)) => return Err(message),
        Err(_) => {
            let _ = stop_tx.send(());
            return Err("Le micro ne répond pas.".into());
        }
    }

    let mut recording = state.recording.lock().map_err(|_| "État illisible.")?;
    if recording.is_some() {
        let _ = stop_tx.send(()); // deux clics très rapprochés : on garde la première dictée
        return Err("Une dictée est déjà en cours.".into());
    }
    // Transcription en direct (elle charge aussi le modèle pendant que tu commences à parler).
    let (cache, s) = (state.context.clone(), shared.clone());
    let live = thread::spawn(move || live_transcription(app, cache, model, language, s, on_event));
    *recording = Some(Recording { stop: stop_tx, thread: handle, live, shared, model, language });
    Ok(())
}

#[tauri::command]
pub async fn stop_dictation(app: AppHandle, state: State<'_, Dictation>) -> Result<String, String> {
    let recording = state
        .recording
        .lock()
        .map_err(|_| "État illisible.")?
        .take()
        .ok_or("Aucune dictée en cours.")?;
    recording.shared.running.store(false, Ordering::Relaxed);
    let _ = recording.stop.send(());
    let cache = state.context.clone();

    tauri::async_runtime::spawn_blocking(move || {
        recording.thread.join().map_err(|_| "Le micro s'est arrêté brutalement.")??;
        let progress = recording.live.join().unwrap_or_default();
        let shared = recording.shared;
        let rate = shared.rate.load(Ordering::Relaxed);
        let buffer = std::mem::take(&mut *shared.buffer.lock().map_err(|_| "Enregistrement illisible.")?);
        if rate == 0 || (buffer.len() as f32) < rate as f32 * MIN_SECONDS {
            return Ok(String::new());
        }
        if buffer.iter().fold(0f32, |m, s| m.max(s.abs())) < SILENCE_PEAK {
            return Err(
                "Aucun son capté. Vérifie que Aery a accès au micro : Réglages Système › Confidentialité et sécurité › Micro.".into(),
            );
        }
        // Il ne reste que le dernier morceau, pas encore figé par la transcription en direct.
        let rest = buffer.get(progress.at..).unwrap_or_default();
        let last = match prepare(rest, rate) {
            Some(audio) if rest.len() as f32 >= rate as f32 * 0.3 => {
                let ctx = load_context(&app, &cache, recording.model)?;
                transcribe(&ctx, &audio, recording.language, prompt_tail(&progress.text), None)?
            }
            _ => String::new(),
        };
        Ok(join_text(&progress.text, &last))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn cancel_dictation(state: State<'_, Dictation>) -> Result<(), String> {
    if let Some(recording) = state.recording.lock().map_err(|_| "État illisible.")?.take() {
        recording.shared.running.store(false, Ordering::Relaxed);
        let _ = recording.stop.send(());
        thread::spawn(move || {
            let _ = recording.thread.join();
            let _ = recording.live.join();
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_sane() {
        for m in MODELS {
            assert_eq!(m.sha256.len(), 64);
            assert!(m.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
            assert!(m.file.ends_with(".bin") && !m.file.contains('/') && !m.file.contains(".."));
            assert!(m.size > 10_000_000);
        }
        assert!(DOWNLOAD_BASE.starts_with("https://huggingface.co/"));
    }

    #[test]
    fn only_known_models_and_languages() {
        assert!(find_model("turbo").is_ok());
        assert!(find_model("../../etc/passwd").is_err());
        assert!(find_model("").is_err());
        assert_eq!(check_language("fr"), Ok("fr"));
        assert!(check_language("fr; rm -rf").is_err());
    }

    #[test]
    fn resample_downsamples_by_averaging() {
        let input: Vec<f32> = (0..48_000).map(|i| if i % 2 == 0 { 1.0 } else { -1.0 }).collect();
        let out = resample(&input, 48_000);
        assert_eq!(out.len(), 16_000);
        // Une fréquence trop aiguë pour 16 kHz disparaît au lieu de se replier en sifflement.
        assert!(out.iter().all(|s| s.abs() < 0.34));
        let constant = resample(&vec![0.5; 44_100], 44_100);
        assert_eq!(constant.len(), 16_000);
        assert!(constant.iter().all(|s| (s - 0.5).abs() < 1e-6));
    }

    #[test]
    fn resample_upsamples_and_keeps_16k() {
        let out = resample(&[0.0, 1.0, 0.0, 1.0], 8_000);
        assert_eq!(out.len(), 8);
        assert!((out[1] - 0.5).abs() < 1e-6);
        assert_eq!(resample(&[0.1, 0.2], 16_000), vec![0.1, 0.2]);
        assert!(resample(&[], 48_000).is_empty());
    }

    #[test]
    fn joins_text_and_detects_pauses() {
        assert_eq!(join_text("Bonjour.", " Ça va ? "), "Bonjour. Ça va ?");
        assert_eq!(join_text("", "Salut"), "Salut");
        assert_eq!(join_text("Salut", ""), "Salut");
        let long = "é".repeat(500);
        assert_eq!(prompt_tail(&long).chars().count(), PROMPT_CHARS);
        assert_eq!(prompt_tail("court"), "court");

        let mut speech = vec![0.3f32; 48_000];
        assert!(!ends_with_pause(&speech, 48_000));
        speech.extend(vec![0.001f32; 48_000]);
        assert!(ends_with_pause(&speech, 48_000));
        assert!(!ends_with_pause(&[0.0; 10], 48_000)); // trop court pour juger
        assert!(prepare(&[0.0; 48_000], 48_000).is_none()); // silence : rien à transcrire
        assert_eq!(prepare(&[0.5; 4_800], 48_000).unwrap().len(), 20_000); // complété à 1,25 s
    }

    #[test]
    fn cleans_noise_and_hallucinations() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(clean_segments(&s(&[" Bonjour à tous.", " [Musique]", " Ça va ?"])), "Bonjour à tous. Ça va ?");
        assert_eq!(clean_segments(&s(&["Sous-titres réalisés par la communauté d'Amara.org"])), "");
        assert_eq!(clean_segments(&s(&[" Merci d'avoir regardé !"])), "");
        assert_eq!(clean_segments(&s(&["(rires)", "*musique*"])), "");
        // Du vrai texte entre parenthèses au milieu d'une phrase reste.
        assert_eq!(clean_segments(&s(&["Il est parti (enfin)."])), "Il est parti (enfin).");
    }
}

/// Test de bout en bout, lancé à la main (télécharge 190 Mo) :
/// `say -v Thomas -o /tmp/x.wav --data-format=LEI16@48000 "…"` puis
/// `DICTATION_TEST_DIR=<dossier> DICTATION_TEST_WAV=/tmp/x.wav cargo test real_dictation -- --ignored --nocapture`
#[cfg(test)]
mod real_tests {
    use super::*;

    /// Lit un WAV 16 bits mono (juste assez pour le test).
    fn read_wav(path: &str) -> (Vec<f32>, u32) {
        let bytes = fs::read(path).unwrap();
        let (mut i, mut rate) = (12, 0);
        // Parcourt les blocs (« JUNK », « fmt », « FLLR »…) jusqu'aux données.
        while &bytes[i..i + 4] != b"data" {
            if &bytes[i..i + 4] == b"fmt " {
                rate = u32::from_le_bytes(bytes[i + 12..i + 16].try_into().unwrap());
            }
            i += 8 + u32::from_le_bytes(bytes[i + 4..i + 8].try_into().unwrap()) as usize;
        }
        assert!(rate > 0);
        let data = &bytes[i + 8..];
        (data.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0).collect(), rate)
    }

    #[tokio::test]
    #[ignore]
    async fn real_dictation() {
        let dir = PathBuf::from(std::env::var("DICTATION_TEST_DIR").unwrap());
        let model = find_model("small").unwrap();
        let path = dir.join(model.file);
        if !path.is_file() {
            let part = dir.join("test.part");
            let channel = Channel::new(|_| Ok(()));
            fetch_model(model, &part, &AtomicBool::new(false), &channel).await.unwrap();
            fs::rename(&part, &path).unwrap();
        }
        let (samples, rate) = read_wav(&std::env::var("DICTATION_TEST_WAV").unwrap());
        let samples = resample(&samples, rate);
        whisper_rs::install_logging_hooks();
        let ctx = WhisperContext::new_with_params(&path, WhisperContextParameters::default()).unwrap();
        let start = Instant::now();
        let text = transcribe(&ctx, &samples, "fr", "", None).unwrap();
        println!("TRANSCRIPTION ({} ms) : {text}", start.elapsed().as_millis());
        assert!(!text.is_empty());

        // Comme en direct : des passages successifs sur un son qui grandit (pas de 0,5 s).
        let step = WHISPER_RATE as usize / 2;
        let mut end = step;
        while end < samples.len() {
            let start = Instant::now();
            let partial = prepare(&samples[..end], WHISPER_RATE)
                .map(|a| transcribe(&ctx, &a, "fr", "", None).unwrap())
                .unwrap_or_default();
            println!("  {:>4.1} s → ({:>3} ms) {partial}", end as f32 / WHISPER_RATE as f32, start.elapsed().as_millis());
            end += step * 2;
        }
    }
}
