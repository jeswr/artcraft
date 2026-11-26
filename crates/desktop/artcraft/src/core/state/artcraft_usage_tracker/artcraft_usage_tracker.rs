use crate::core::state::artcraft_usage_tracker::artcraft_usage_tracker_data::ArtcraftUsageTrackerData;
use std::sync::{Arc, LockResult, RwLock};
use log::{error, warn};
use crate::core::artcraft_error::ArtcraftError;
use crate::core::pod_mode::state::PodModeState;
use crate::core::state::artcraft_usage_tracker::artcraft_usage_type::{ArtcraftUsagePage, ArtcraftUsageType};

/// Track generation volume so we know which areas to focus efforts on.
/// But also note: https://en.wikipedia.org/wiki/Survivorship_bias
/// The counts are usage analytics: `counting_allowed` is read under the write lock on each record,
/// and a pod-mode window counts nothing.
#[derive(Clone)]
pub struct ArtcraftUsageTracker {
  data: Arc<RwLock<ArtcraftUsageTrackerData>>,
  counting_allowed: Arc<dyn Fn() -> bool + Send + Sync>,
}


impl ArtcraftUsageTracker {
  /// A tracker that counts only while `pod_mode` is not restricted, and drops every count at the
  /// moment the record becomes restricted. Counts made after pod mode is left are kept for the
  /// next report.
  pub fn gated_by(pod_mode: &Arc<PodModeState>) -> Self {
    // Weak, so the hook the state holds does not keep the state alive through the tracker.
    let gate = Arc::downgrade(pod_mode);
    let tracker = Self::new_with_gate(Arc::new(move || gate.upgrade().is_some_and(|state| !state.restricted())));
    let cleared = tracker.clone();
    pod_mode.on_restricted(move || {
      if let Err(err) = cleared.reset() {
        error!("Could not drop the usage counts on entering pod mode: {:?}", err);
      }
    });
    tracker
  }

  pub fn new_with_gate(counting_allowed: Arc<dyn Fn() -> bool + Send + Sync>) -> Self {
    Self {
      data: Arc::new(RwLock::new(ArtcraftUsageTrackerData::new())),
      counting_allowed,
    }
  }

  /// Drops every count. `gated_by` calls it when the window enters pod mode.
  pub fn reset(&self) -> Result<(), ArtcraftError> {
    self.set(ArtcraftUsageTrackerData::new())
  }
  
  pub fn record_image_generation(&self, num_images: u16, usage_type: ArtcraftUsageType, page: ArtcraftUsagePage) -> Result<(), ArtcraftError> {
    self.count(|data| {
      data.total_generation_count += num_images;
      data.image_generation_count += num_images;
      match usage_type {
        ArtcraftUsageType::TextToResult => {
          data.text_to_image_count += num_images;
        }
        ArtcraftUsageType::ImageToResult => {
          data.image_to_image_count += num_images;
        }
        ArtcraftUsageType::Other => {}
      }
      match page {
        ArtcraftUsagePage::ImagePage => {
          data.image_page_prompt_count += num_images;
        }
        ArtcraftUsagePage::EditPage => {
          data.edit_page_prompt_count += num_images;
        }
        ArtcraftUsagePage::StagePage => {
          data.stage_page_prompt_count += num_images;
        }
        ArtcraftUsagePage::OtherPage => {
          data.other_page_prompt_count += num_images;
        }
        ArtcraftUsagePage::VideoPage => {} // NB: Does not generate images.
        ArtcraftUsagePage::ObjectPage => {} // NB: Does not generate images.
      }
    })
  }
  
  pub fn record_video_generation(&self, num_videos: u16, usage_type: ArtcraftUsageType, page: ArtcraftUsagePage) -> Result<(), ArtcraftError> {
    self.count(|data| {
      data.total_generation_count += num_videos;
      data.video_generation_count += num_videos;
      match usage_type {
        ArtcraftUsageType::TextToResult => {
          data.text_to_video_count += num_videos;
        }
        ArtcraftUsageType::ImageToResult => {
          data.image_to_video_count += num_videos;
        }
        ArtcraftUsageType::Other => {}
      }
      match page {
        ArtcraftUsagePage::VideoPage => {
          data.video_page_prompt_count += num_videos;
        }
        ArtcraftUsagePage::OtherPage => {
          data.other_page_prompt_count += num_videos;
        }
        ArtcraftUsagePage::ImagePage => {} // NB: Does not generate videos.
        ArtcraftUsagePage::EditPage => {} // NB: Does not generate videos.
        ArtcraftUsagePage::StagePage => {} // NB: Does not generate videos.
        ArtcraftUsagePage::ObjectPage => {} // NB: Does not generate videos.
      }
    })
  }
  
  pub fn record_object_generation(&self, num_objects: u16, usage_type: ArtcraftUsageType, page: ArtcraftUsagePage) -> Result<(), ArtcraftError> {
    self.count(|data| {
      data.total_generation_count += num_objects;
      data.object_generation_count += num_objects;
      match usage_type {
        ArtcraftUsageType::TextToResult => {
          data.text_to_object_count += num_objects;
        }
        ArtcraftUsageType::ImageToResult => {
          data.image_to_object_count += num_objects;
        }
        ArtcraftUsageType::Other => {}
      }
      match page {
        ArtcraftUsagePage::ObjectPage => {
          data.object_page_prompt_count += num_objects;
        }
        ArtcraftUsagePage::OtherPage => {
          data.other_page_prompt_count += num_objects;
        }
        ArtcraftUsagePage::ImagePage => {} // NB: Does not generate objects.
        ArtcraftUsagePage::VideoPage => {} // NB: Does not generate objects.
        ArtcraftUsagePage::EditPage => {} // NB: Does not generate objects.
        ArtcraftUsagePage::StagePage => {} // NB: Does not generate objects.
      }
    })
  }
  
  pub fn get(&self) -> Result<ArtcraftUsageTrackerData, ArtcraftError> {
    match self.data.read() {
      Ok(data) => Ok(data.clone()),
      Err(err) => {
        error!("Lock read error: {:?}", err);
        Err(ArtcraftError::RwLockReadError)
      }
    }
  }
  
  /// Applies one record when counting is allowed. The gate is read under the write lock, so a
  /// count that passed it cannot land after the reset made on entering pod mode.
  fn count(&self, apply: impl FnOnce(&mut ArtcraftUsageTrackerData)) -> Result<(), ArtcraftError> {
    let mut data = match self.data.write() {
      Ok(lock) => lock,
      Err(err) => {
        error!("Lock write error: {:?}", err);
        return Err(ArtcraftError::RwLockWriteError);
      }
    };
    if (self.counting_allowed)() {
      apply(&mut data);
    }
    Ok(())
  }

  fn set(&self, data: ArtcraftUsageTrackerData) -> Result<(), ArtcraftError> {
    match self.data.write() {
      Ok(mut lock) => {
        *lock = data;
        Ok(())
      },
      Err(err) => {
        error!("Lock write error: {:?}", err);
        Err(ArtcraftError::RwLockWriteError)
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::atomic::{AtomicBool, Ordering};

  #[test]
  fn nothing_is_counted_while_the_gate_is_closed_and_reset_drops_the_counts() {
    let open = Arc::new(AtomicBool::new(true));
    let gate = open.clone();
    let tracker = ArtcraftUsageTracker::new_with_gate(Arc::new(move || gate.load(Ordering::SeqCst)));
    tracker.record_image_generation(2, ArtcraftUsageType::TextToResult, ArtcraftUsagePage::ImagePage).unwrap();
    let counted = tracker.get().unwrap().total_generation_count;
    assert!(counted > 0);

    open.store(false, Ordering::SeqCst);
    tracker.record_image_generation(2, ArtcraftUsageType::TextToResult, ArtcraftUsagePage::ImagePage).unwrap();
    tracker.record_video_generation(1, ArtcraftUsageType::TextToResult, ArtcraftUsagePage::VideoPage).unwrap();
    tracker.record_object_generation(1, ArtcraftUsageType::TextToResult, ArtcraftUsagePage::ObjectPage).unwrap();
    assert_eq!(tracker.get().unwrap().total_generation_count, counted);

    tracker.reset().unwrap();
    assert!(tracker.get().unwrap().total_generation_count < counted);
  }

  #[test]
  fn counts_are_dropped_on_entering_pod_mode_and_those_made_after_leaving_are_kept() {
    use crate::core::pod_mode::state::SharedPodModeState;
    use pod_mode::controller::Store;
    use pod_mode::origin::Loopback;
    use pod_mode::record::PodModeRecord;

    let base = tempfile::tempdir().unwrap();
    let state = Arc::new(PodModeState::load(base.path().to_path_buf(), "x.y"));
    let store = SharedPodModeState(state.clone());
    let tracker = ArtcraftUsageTracker::gated_by(&state);
    let count = || tracker.get().unwrap().total_generation_count;

    tracker.record_image_generation(2, ArtcraftUsageType::TextToResult, ArtcraftUsagePage::ImagePage).unwrap();
    assert!(count() > 0);
    // Entering drops what was counted before, at once.
    let entered = pod_mode::transition::enter("https://login.example", Loopback::HttpRefused).unwrap();
    store.replace(&entered).unwrap();
    assert_eq!(count(), 0);
    tracker.record_image_generation(2, ArtcraftUsageType::TextToResult, ArtcraftUsagePage::ImagePage).unwrap();
    assert_eq!(count(), 0);
    // Leaving drops nothing: generations made in ordinary mode wait for the next report.
    store.replace(&PodModeRecord::default()).unwrap();
    tracker.record_image_generation(3, ArtcraftUsageType::TextToResult, ArtcraftUsagePage::ImagePage).unwrap();
    let after = count();
    assert!(after > 0);
    store.replace(&PodModeRecord::default()).unwrap();
    assert_eq!(count(), after);
  }
}
