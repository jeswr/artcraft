use crate::core::pod_mode::state::PodModeState;
use crate::core::state::app_env_configs::app_env_configs::AppEnvConfigs;
use crate::core::state::artcraft_platform_info::ArtcraftPlatformInfo;
use crate::core::state::artcraft_usage_tracker::artcraft_usage_tracker::ArtcraftUsageTracker;
use crate::services::storyteller::state::storyteller_credential_manager::StorytellerCredentialManager;
use anyhow::anyhow;
use artcraft_api_defs::analytics::log_active_user::{LogAppActiveUserRequest, LOG_ACTIVE_USER_V2_PATH};
use artcraft_client::endpoints::analytics::log_active_user_v2::log_active_user_v2;
use artcraft_client::error::api_error::ApiError;
use artcraft_client::credentials::storyteller_credential_set::StorytellerCredentialSet;
use artcraft_client::error::storyteller_error::StorytellerError;
use errors::AnyhowResult;
use log::{debug, error, info};
use pod_mode::activity::{ActivityGate, ActivityStep};
use sqlite_tasks::queries::list_tasks_by_provider_and_tokens::{list_tasks_by_provider_and_tokens, ListTasksArgs};
use std::sync::Arc;
use std::time::Instant;
use tokens::tokens::app_session::AppSessionToken;

const CLIENT_NAME : &str = "artcraft";

const ERROR_SLEEP_MILLIS : u64 = 1_000 * 60 * 3; // 3 minutes;

/// Reports activity to the hosted API. This is usage analytics, so it sends nothing while the
/// window is restricted (pod mode, or pod credentials not yet wiped), and a session never spans
/// such a period (see `pod_mode::activity`).
pub async fn storyteller_activity_thread(
  pod_mode: Arc<PodModeState>,
  app_env_configs: AppEnvConfigs,
  artcraft_platform_info: ArtcraftPlatformInfo,
  artcraft_usage_tracker: ArtcraftUsageTracker,
  storyteller_creds_manager: StorytellerCredentialManager,
) -> ! {
  let mut session = ActivitySession::start();
  let mut gate = ActivityGate::default();

  loop {
    let res = polling_loop(
      &pod_mode,
      &mut gate,
      &mut session,
      &app_env_configs,
      &artcraft_usage_tracker,
      &storyteller_creds_manager,
      &artcraft_platform_info,
    ).await;
    if let Err(err) = res {
      error!("Activity request failed: origin={} path={} error={:?}", app_env_configs.storyteller_host.to_api_hostname_and_scheme(), LOG_ACTIVE_USER_V2_PATH, err);
    }
    // NB: Sleep if an error occurs.
    tokio::time::sleep(std::time::Duration::from_millis(ERROR_SLEEP_MILLIS)).await;
  }
}

struct ActivitySession {
  startup: Instant,
  token: AppSessionToken,
}

impl ActivitySession {
  fn start() -> Self {
    let session = Self { startup: Instant::now(), token: AppSessionToken::generate() };
    info!("Session started at {:?} with token: {:?}", session.startup, session.token);
    session
  }
}

async fn polling_loop(
  pod_mode: &PodModeState,
  gate: &mut ActivityGate,
  session: &mut ActivitySession,
  app_env_configs: &AppEnvConfigs,
  artcraft_usage_tracker: &ArtcraftUsageTracker,
  storyteller_creds_manager: &StorytellerCredentialManager,
  artcraft_platform_info: &ArtcraftPlatformInfo,
) -> AnyhowResult<()> {
  loop {
    match gate.step(pod_mode.restricted(), pod_mode.restricted_periods()) {
      ActivityStep::Hold => {
        tokio::time::sleep(std::time::Duration::from_millis(5_000)).await;
        continue;
      }
      ActivityStep::Report { new_session: true } => {
        // No token or duration from before or during the restricted period goes into the next
        // report. The counts were already dropped when the window became restricted (see
        // `ArtcraftUsageTracker::gated_by`); those made since it was left are kept.
        *session = ActivitySession::start();
      }
      ActivityStep::Report { new_session: false } => {}
    }

    let creds = storyteller_creds_manager.get_credentials()?;

    let creds = match creds {
      None => {
        tokio::time::sleep(std::time::Duration::from_millis(5_000)).await;
        continue;
      }
      Some(creds) => {
        if !has_activity_session(&creds) {
          tokio::time::sleep(std::time::Duration::from_millis(5_000)).await;
          continue;
        }
        creds
      },
    };

    let usage_data = artcraft_usage_tracker.get()?;
    
    let time_since_startup = Instant::now().duration_since(session.startup);

    let request = LogAppActiveUserRequest {
      maybe_app_session_token: Some(session.token.clone()),
      maybe_app_name: Some(CLIENT_NAME.to_string()),
      maybe_app_version: Some(artcraft_platform_info.artcraft_version.clone()),
      maybe_os_platform: Some(artcraft_platform_info.os_platform.as_str().to_owned()),
      maybe_os_version: Some(artcraft_platform_info.os_version.clone()),
      maybe_session_duration_seconds: Some(time_since_startup.as_secs()),
      total_generation_count: Some(usage_data.total_generation_count),
      image_generation_count: Some(usage_data.image_generation_count),
      video_generation_count: Some(usage_data.video_generation_count),
      object_generation_count: Some(usage_data.object_generation_count),
      text_to_image_count: Some(usage_data.text_to_image_count),
      image_to_image_count: Some(usage_data.image_to_image_count),
      text_to_video_count: Some(usage_data.text_to_video_count),
      image_to_video_count: Some(usage_data.image_to_video_count),
      text_to_object_count: Some(usage_data.text_to_object_count),
      image_to_object_count: Some(usage_data.image_to_object_count),
      image_page_prompt_count: Some(usage_data.image_page_prompt_count),
      video_page_prompt_count: Some(usage_data.video_page_prompt_count),
      edit_page_prompt_count: Some(usage_data.edit_page_prompt_count),
      stage_page_prompt_count: Some(usage_data.stage_page_prompt_count),
      object_page_prompt_count: Some(usage_data.object_page_prompt_count),
      other_page_prompt_count: Some(usage_data.other_page_prompt_count),
    };

    debug!("Logging active user with storyteller.");

    let result = log_active_user_v2(
      &app_env_configs.storyteller_host,
      Some(&creds),
      request,
    ).await;

    let wait_millis = match result {
      Ok(result) => result.wait_for_retry_millis,
      Err(err) => {
        match &err {
          StorytellerError::Api(ApiError::TooManyRequests(message)) => {
            error!("Too many requests (sleeping): {:?}", message);
            tokio::time::sleep(std::time::Duration::from_millis(ERROR_SLEEP_MILLIS)).await;
            continue;
          }
          _ => {}
        }
        return Err(anyhow!(err));
      }
    };

    // Wait at least a minute, no matter what the server tells us.
    let wait_millis = std::cmp::max(wait_millis, 60_000);
    tokio::time::sleep(std::time::Duration::from_millis(wait_millis)).await;
  }
}

// Anonymous visitor tracking is not authentication for active_user_v2.
fn has_activity_session(creds: &StorytellerCredentialSet) -> bool {
  creds.session.as_ref().map(|session| !session.as_str().is_empty()).unwrap_or(false)
}

#[cfg(test)]
mod login_bridge_tests {
  use super::has_activity_session;
  use artcraft_client::credentials::storyteller_credential_set::StorytellerCredentialSet;
  use artcraft_client::credentials::storyteller_avt_cookie::StorytellerAvtCookie;
  use artcraft_client::credentials::storyteller_session_cookie::StorytellerSessionCookie;

  #[test]
  fn anonymous_visitor_cookie_does_not_authorize_activity_requests() {
    assert!(!has_activity_session(&StorytellerCredentialSet::empty()));
    let visitor_only = StorytellerCredentialSet::initialize_with_just_avt(StorytellerAvtCookie::new("visitor_fixture".into()));
    assert!(!has_activity_session(&visitor_only));
    let empty_session = StorytellerCredentialSet::initialize_with_just_cookie(StorytellerSessionCookie::new(String::new()));
    assert!(!has_activity_session(&empty_session));
    let signed_in = StorytellerCredentialSet::initialize_with_just_cookie(StorytellerSessionCookie::new("signed_session_fixture".into()));
    assert!(has_activity_session(&signed_in));
  }
}
