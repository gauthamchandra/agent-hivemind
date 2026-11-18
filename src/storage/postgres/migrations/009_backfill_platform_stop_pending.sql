UPDATE sessions
  SET platform_stop_pending = true
  WHERE final_usage_pending
    AND platform_session_ref IS NOT NULL
    AND life IN ('ended', 'start_failed');
