//! Son du Mac : enregistrer ce qui sort des haut-parleurs (vidéo, réunion, cours en ligne…)
//! pour le transcrire comme une dictée (voir `dictation.rs`, source `System`).
//!
//! macOS (14.2+) le permet avec un « process tap » de Core Audio :
//!  1. un tap global qui mélange en stéréo le son de TOUTES les applis (sans le couper : on
//!     continue à l'entendre normalement) ;
//!  2. un périphérique agrégé privé (visible seulement par Aery) qui expose ce tap comme une entrée ;
//!  3. cpal ouvre ce périphérique comme un micro ordinaire.
//!
//! Pourquoi pas la fonction « loopback » de cpal ? Elle enregistre la sortie par défaut, sauf si
//! celle-ci a aussi un micro (AirPods, casque Bluetooth) : elle ouvrirait alors… le micro du casque.
//! Le tap global n'a pas ce piège, quel que soit l'appareil de sortie.
//!
//! Autorisation : « Enregistrement audio du système » (Réglages Système › Confidentialité et
//! sécurité), demandée par macOS au premier usage grâce à `NSAudioCaptureUsageDescription`
//! (`Info.plist`). Refusée, macOS ne renvoie que du silence (pas d'erreur).

use cpal::traits::{DeviceTrait, HostTrait};
use objc2::AnyThread;
use objc2_core_audio::{
    AudioHardwareCreateAggregateDevice, AudioHardwareCreateProcessTap, AudioHardwareDestroyAggregateDevice,
    AudioHardwareDestroyProcessTap, AudioObjectID, CATapDescription, CATapMuteBehavior, kAudioAggregateDeviceIsPrivateKey,
    kAudioAggregateDeviceNameKey, kAudioAggregateDeviceTapAutoStartKey, kAudioAggregateDeviceTapListKey,
    kAudioAggregateDeviceUIDKey, kAudioSubTapDriftCompensationKey, kAudioSubTapUIDKey,
};
use objc2_core_foundation::{
    CFArray, CFDictionary, CFMutableDictionary, CFRetained, CFString, kCFAllocatorDefault, kCFTypeArrayCallBacks,
    kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks,
};
use objc2_foundation::{NSArray, NSNumber, NSString};
use std::{
    ffi::{CStr, c_void},
    ptr::NonNull,
    sync::atomic::{AtomicU32, Ordering},
};

static INSTANCE: AtomicU32 = AtomicU32::new(0);

/// Le tap et son périphérique agrégé. Les deux sont détruits avec lui : le garder vivant tant que
/// le flux cpal tourne, et le lâcher APRÈS le flux.
pub struct SystemTap {
    tap: AudioObjectID,
    aggregate: AudioObjectID,
}

impl Drop for SystemTap {
    fn drop(&mut self) {
        unsafe {
            AudioHardwareDestroyAggregateDevice(self.aggregate);
            AudioHardwareDestroyProcessTap(self.tap);
        }
    }
}

/// Crée le tap et renvoie le périphérique cpal à ouvrir en entrée.
pub fn open() -> Result<(SystemTap, cpal::Device), String> {
    let instance = INSTANCE.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let uid = format!("com.freellmchat.app.system-audio.{pid}.{instance}");

    // 1. Tap global : toutes les applis (aucune exclue), son toujours audible.
    let description = unsafe {
        let d = CATapDescription::initStereoGlobalTapButExcludeProcesses(CATapDescription::alloc(), &NSArray::new());
        d.setMuteBehavior(CATapMuteBehavior::Unmuted);
        d.setPrivate(true);
        d.setName(&NSString::from_str("Aery : son du Mac"));
        d
    };
    let mut tap: AudioObjectID = 0;
    let status = unsafe { AudioHardwareCreateProcessTap(Some(&description), &mut tap) };
    if status != 0 || tap == 0 {
        return Err(format!(
            "Impossible d'écouter le son du Mac (erreur {status}). Il faut macOS 14.2 ou plus récent."
        ));
    }
    let tap_uid = unsafe { description.UUID().UUIDString() };

    // 2. Périphérique agrégé privé qui contient seulement ce tap.
    let properties = aggregate_properties(&tap_uid, &uid);
    let mut aggregate: AudioObjectID = 0;
    let status = unsafe { AudioHardwareCreateAggregateDevice(&properties, NonNull::from(&mut aggregate)) };
    if status != 0 || aggregate == 0 {
        unsafe { AudioHardwareDestroyProcessTap(tap) };
        return Err(format!("Impossible de préparer l'écoute du son du Mac (erreur {status})."));
    }
    let handle = SystemTap { tap, aggregate };

    // 3. cpal le voit comme une entrée ordinaire : on le retrouve par son identifiant.
    let wanted = cpal::DeviceId::new(cpal::HostId::CoreAudio, &uid);
    let device = cpal::default_host()
        .input_devices()
        .map_err(|e| format!("Liste des périphériques audio illisible : {e}"))?
        .find(|d| d.id().is_ok_and(|id| id == wanted))
        .ok_or("Le périphérique d'écoute du son du Mac n'apparaît pas.")?;
    Ok((handle, device))
}

fn key(name: &'static CStr) -> CFRetained<CFString> {
    CFString::from_str(name.to_str().unwrap_or_default())
}

fn set(dict: &CFMutableDictionary, k: &CFString, value: *const c_void) {
    unsafe { CFMutableDictionary::set_value(Some(dict), k as *const _ as *const c_void, value) };
}

/// Équivalent de :
/// `@{ name, uid, private: YES, tapAutoStart: YES, taps: @[ @{ uid: tapUID, drift: YES } ] }`
fn aggregate_properties(tap_uid: &NSString, uid: &str) -> CFRetained<CFDictionary> {
    let yes = NSNumber::new_bool(true);
    let yes = &*yes as *const NSNumber as *const c_void;
    unsafe {
        let tap = CFMutableDictionary::new(kCFAllocatorDefault, 2, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks)
            .expect("CFDictionary");
        set(&tap, &key(kAudioSubTapUIDKey), tap_uid as *const NSString as *const c_void);
        set(&tap, &key(kAudioSubTapDriftCompensationKey), yes);
        let mut taps_list = [&*tap as *const CFMutableDictionary as *const c_void];
        let taps = CFArray::new(kCFAllocatorDefault, taps_list.as_mut_ptr(), 1, &kCFTypeArrayCallBacks).expect("CFArray");

        let dict = CFMutableDictionary::new(kCFAllocatorDefault, 5, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks)
            .expect("CFDictionary");
        let name = CFString::from_str("Aery : son du Mac");
        let uid = CFString::from_str(uid);
        set(&dict, &key(kAudioAggregateDeviceNameKey), &*name as *const CFString as *const c_void);
        set(&dict, &key(kAudioAggregateDeviceUIDKey), &*uid as *const CFString as *const c_void);
        set(&dict, &key(kAudioAggregateDeviceTapListKey), &*taps as *const CFArray as *const c_void);
        set(&dict, &key(kAudioAggregateDeviceTapAutoStartKey), yes);
        set(&dict, &key(kAudioAggregateDeviceIsPrivateKey), yes);
        CFRetained::cast_unchecked::<CFDictionary>(dict)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Crée vraiment le tap (macOS 14.2+) et vérifie que cpal le voit comme une entrée.
    /// Sans l'autorisation « Enregistrement audio du système », le son serait muet, mais le
    /// périphérique existe quand même.
    #[test]
    #[ignore]
    fn real_system_tap() {
        let (_tap, device) = open().expect("tap");
        let config = device.default_input_config().expect("config");
        eprintln!("son du Mac : {} Hz, {} canaux", config.sample_rate(), config.channels());
        assert!(config.channels() >= 1);
    }

    /// Fait parler le Mac (`say`) et vérifie que du son arrive. Demande l'autorisation
    /// « Enregistrement audio du système » pour le terminal : sans elle, le test échoue (silence).
    #[test]
    #[ignore]
    fn real_system_audio_hears_say() {
        use cpal::traits::StreamTrait;
        use std::sync::{Arc, Mutex};
        let (tap, device) = open().expect("tap");
        let config = device.default_input_config().expect("config");
        let peak = Arc::new(Mutex::new(0f32));
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (p, c) = (peak.clone(), calls.clone());
        let stream = device
            .build_input_stream::<f32, _, _>(
                config.config(),
                move |data: &[f32], _| {
                    c.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let m = data.iter().fold(0f32, |m, s| m.max(s.abs()));
                    let mut p = p.lock().unwrap();
                    *p = p.max(m);
                },
                |e| eprintln!("{e}"),
                None,
            )
            .expect("flux");
        stream.play().expect("play");
        std::process::Command::new("/usr/bin/say").arg("Bonjour, ceci est un test.").status().expect("say");
        drop(stream);
        drop(tap);
        let peak = *peak.lock().unwrap();
        eprintln!("niveau max : {peak}, {} paquets reçus", calls.load(std::sync::atomic::Ordering::Relaxed));
        assert!(peak > 0.002, "silence : autorisation refusée ?");
    }
}
