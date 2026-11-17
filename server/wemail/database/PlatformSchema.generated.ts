// Canonical non-mail product schema. Do not edit generated blocks by hand.

export const MAIL_DATABASE_PLATFORM_SCHEMA_BLOCKS = [
  // Canonical platform object: agent_conversations
  `CREATE TABLE agent_conversations (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      , archived_at TEXT, pinned_at TEXT)`,

  // Canonical platform object: agent_messages
  `CREATE TABLE agent_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        body_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES agent_conversations(id) ON DELETE CASCADE
      )`,

  // Canonical platform object: agent_pending_actions
  `CREATE TABLE agent_pending_actions (
        id TEXT PRIMARY KEY,
        conversation_id TEXT,
        action_type TEXT NOT NULL,
        description TEXT NOT NULL,
        email_id TEXT,
        input_json TEXT NOT NULL,
        risk_reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        resolved_at TEXT, risk_level TEXT, account_id TEXT, mcp_operation_id TEXT, owner_type TEXT NOT NULL DEFAULT 'account'
      CHECK(owner_type IN ('account', 'local_profile')), owner_profile_id TEXT,
        FOREIGN KEY(conversation_id) REFERENCES agent_conversations(id) ON DELETE CASCADE
      )`,

  // Canonical platform object: ai_profile_settings
  `CREATE TABLE ai_profile_settings (
        id TEXT PRIMARY KEY,
        user_display_name TEXT,
        assistant_preference TEXT,
        summary_language TEXT,
        todo_language TEXT,
        compose_language TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      , translation_language TEXT, important_contacts_json TEXT, default_summary_language TEXT, default_reply_tone TEXT, signature_preference TEXT, custom_instructions TEXT, todo_prompt TEXT, worker_concurrency INTEGER CHECK(worker_concurrency BETWEEN 1 AND 16))`,

  // Canonical platform object: ai_usage
  `CREATE TABLE ai_usage (
        id TEXT PRIMARY KEY,
        processor TEXT NOT NULL,
        email_id TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        model TEXT,
        provider TEXT,
        caller_source TEXT,
        session_id TEXT,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      , account_id TEXT NOT NULL DEFAULT 'local', category TEXT NOT NULL DEFAULT 'other', processor_version INTEGER NOT NULL DEFAULT 1)`,

  // Canonical platform object: application_messages
  `CREATE TABLE application_messages (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_rule_id TEXT,
        source_run_id TEXT,
        message_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        preview TEXT NOT NULL,
        content_json TEXT NOT NULL,
        references_json TEXT NOT NULL,
        interactions_json TEXT NOT NULL,
        read_at TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT
      , artifact_id TEXT, artifact_version INTEGER, artifact_kind TEXT, artifact_content_hash TEXT, key_metrics_json TEXT, delayed INTEGER NOT NULL DEFAULT 0, owner_type TEXT NOT NULL DEFAULT 'account'
      CHECK(owner_type IN ('account', 'local_profile')), owner_profile_id TEXT)`,

  // Canonical platform object: automation_center_settings
  `CREATE TABLE automation_center_settings (
        profile_id TEXT PRIMARY KEY,
        unified_read_enabled INTEGER NOT NULL DEFAULT 0,
        template_creation_enabled INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )`,

  // Canonical platform object: automation_deferred_executions
  `CREATE TABLE automation_deferred_executions (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        account_id TEXT NOT NULL,
        email_id TEXT NOT NULL,
        due_at TEXT,
        actions_json TEXT NOT NULL,
        execution_json TEXT,
        dependencies_json TEXT NOT NULL DEFAULT '[]',
        resolution_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT)`,

  // Canonical platform object: automation_provider_cache
  `CREATE TABLE automation_provider_cache (
        provider TEXT NOT NULL,
        capability TEXT NOT NULL,
        descriptor_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        discovered_at TEXT NOT NULL,
        expires_at TEXT,
        PRIMARY KEY(provider, capability)
      )`,

  // Canonical platform object: automation_result_envelopes
  `CREATE TABLE automation_result_envelopes (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        schema_id TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        renderer_id TEXT NOT NULL,
        renderer_version TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        provenance_json TEXT NOT NULL DEFAULT '[]',
        action_candidates_json TEXT NOT NULL DEFAULT '[]',
        warnings_json TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT NOT NULL,
        retention_class TEXT NOT NULL DEFAULT 'detail_30d',
        created_at TEXT NOT NULL,
        expires_at TEXT
      )`,

  // Canonical platform object: automation_rule_previews
  `CREATE TABLE automation_rule_previews (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        source_rule_id TEXT,
        source_rule_version TEXT,
        normalized_rule_json TEXT NOT NULL,
        rule_hash TEXT NOT NULL,
        capability_fingerprint TEXT NOT NULL,
        preview_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`,

  // Canonical platform object: automation_rule_references
  `CREATE TABLE automation_rule_references (
        rule_id TEXT NOT NULL,
        reference_type TEXT NOT NULL,
        reference_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(rule_id, reference_type, reference_id)
      )`,

  // Canonical platform object: automation_rule_runs
  `CREATE TABLE automation_rule_runs (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        dry_run INTEGER NOT NULL,
        matched_count INTEGER NOT NULL,
        applied_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      , suggestion_id TEXT, matched_ids_json TEXT, match_reasons_json TEXT, trigger_kind TEXT, trigger_key TEXT, status TEXT, action_results_json TEXT, planned_occurrence_key TEXT, planned_window_start TEXT, planned_window_end TEXT, run_revision INTEGER NOT NULL DEFAULT 0, rule_version INTEGER, template_id TEXT, template_version TEXT, template_hash TEXT, pipeline_hash TEXT, recipe_hash TEXT, renderer_id TEXT, renderer_version TEXT, account_scope_json TEXT, resolved_accounts_json TEXT, model_resolution_json TEXT, delivery_policy_json TEXT, result_envelope_id TEXT, completed_at TEXT, expires_at TEXT, retention_class TEXT NOT NULL DEFAULT 'summary')`,

  // Canonical platform object: automation_rule_runtime_state
  `CREATE TABLE automation_rule_runtime_state (
        rule_id TEXT PRIMARY KEY,
        rule_version INTEGER NOT NULL,
        last_scheduled_at TEXT,
        last_started_at TEXT,
        last_completed_at TEXT,
        next_run_at TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        paused_reason TEXT,
        updated_at TEXT NOT NULL
      )`,

  // Canonical platform object: automation_rule_versions
  `CREATE TABLE automation_rule_versions (
        rule_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        account_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        rule_json TEXT NOT NULL,
        rule_hash TEXT NOT NULL,
        created_at TEXT NOT NULL, owner_type TEXT NOT NULL DEFAULT 'account'
        CHECK(owner_type IN ('account', 'local_profile')), owner_profile_id TEXT, account_scope_json TEXT, template_id TEXT, template_version TEXT, template_hash TEXT, result_schema_id TEXT, result_schema_version TEXT, renderer_id TEXT, renderer_version TEXT,
        PRIMARY KEY(rule_id, version)
      )`,

  // Canonical platform object: automation_rules
  `CREATE TABLE automation_rules (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        conditions_json TEXT NOT NULL,
        actions_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      , trigger_json TEXT, natural_language_condition TEXT, condition_mode TEXT, condition_rules_json TEXT, processing_json TEXT, schema_version INTEGER NOT NULL DEFAULT 1, current_version INTEGER NOT NULL DEFAULT 1, description TEXT, pipeline_json TEXT, authorization_json TEXT, capability_snapshots_json TEXT, skill_snapshots_json TEXT NOT NULL DEFAULT '[]', data_selection_recipe_json TEXT, analysis_recipe_json TEXT, artifact_recipe_json TEXT, delivery_plan_json TEXT, accepted_reviews_json TEXT NOT NULL DEFAULT '[]', compiled_pipeline_hash TEXT, owner_type TEXT NOT NULL DEFAULT 'account'
        CHECK(owner_type IN ('account', 'local_profile')), owner_profile_id TEXT, account_scope_json TEXT, template_id TEXT, template_version TEXT, template_hash TEXT, result_schema_id TEXT, result_schema_version TEXT, renderer_id TEXT, renderer_version TEXT, archived_at TEXT)`,

  // Canonical platform object: automation_run_manifest_items
  `CREATE TABLE automation_run_manifest_items (
        run_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        account_id TEXT NOT NULL,
        reference_type TEXT NOT NULL CHECK(reference_type IN ('mail', 'attachment', 'application_message')),
        reference_id TEXT NOT NULL,
        parent_reference_id TEXT,
        occurred_at TEXT NOT NULL,
        selection_reason TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY(run_id, ordinal),
        FOREIGN KEY(run_id) REFERENCES automation_run_manifests(run_id)
          ON DELETE CASCADE
      )`,

  // Canonical platform object: automation_run_manifests
  `CREATE TABLE automation_run_manifests (
        run_id TEXT PRIMARY KEY,
        account_scope_json TEXT NOT NULL,
        per_account_counts_json TEXT NOT NULL DEFAULT '{}',
        item_count INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL,
        retention_class TEXT NOT NULL DEFAULT 'detail_30d',
        created_at TEXT NOT NULL,
        expires_at TEXT
      )`,

  // Canonical platform object: automation_step_runs
  `CREATE TABLE automation_step_runs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        rule_version INTEGER NOT NULL,
        step_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        capability TEXT NOT NULL,
        capability_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        input_summary_json TEXT,
        output_json TEXT,
        warnings_json TEXT NOT NULL,
        side_effects_json TEXT NOT NULL,
        error_json TEXT,
        external_audit_id TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL
      , duration_ms INTEGER NOT NULL DEFAULT 0, stage TEXT, sequence INTEGER NOT NULL DEFAULT 0, run_revision INTEGER NOT NULL DEFAULT 0, output_summary_json TEXT, usage_json TEXT, retry_safety_json TEXT, effect_evidence_json TEXT, delivery_destination_json TEXT, retention_class TEXT NOT NULL DEFAULT 'detail_30d', expires_at TEXT)`,

  // Canonical platform object: automation_template_packages
  `CREATE TABLE automation_template_packages (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK(source IN ('builtin', 'personal')),
        active_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,

  // Canonical platform object: automation_template_previews
  `CREATE TABLE automation_template_previews (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        template_id TEXT NOT NULL,
        template_version TEXT NOT NULL,
        template_hash TEXT NOT NULL,
        configuration_json TEXT NOT NULL,
        draft_json TEXT NOT NULL,
        preview_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`,

  // Canonical platform object: automation_template_versions
  `CREATE TABLE automation_template_versions (
        template_id TEXT NOT NULL,
        version TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('builtin', 'personal')),
        manifest_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        compatibility_json TEXT NOT NULL DEFAULT '{}',
        active INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        PRIMARY KEY(template_id, version),
        FOREIGN KEY(template_id) REFERENCES automation_template_packages(id)
          ON DELETE CASCADE
      )`,

  // Canonical platform object: bot_channel_configurations
  `CREATE TABLE bot_channel_configurations (
        platform TEXT PRIMARY KEY CHECK(platform IN ('feishu', 'wecom')),
        connection_id TEXT NOT NULL UNIQUE,
        profile_id TEXT NOT NULL UNIQUE,
        external_bot_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        secret_ref TEXT NOT NULL,
        ws_url TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(connection_id) REFERENCES langbot_connections(id) ON DELETE CASCADE,
        FOREIGN KEY(profile_id) REFERENCES channel_bot_profiles(id) ON DELETE CASCADE
      )`,

  // Canonical platform object: business_preferences
  `CREATE TABLE business_preferences (
        id TEXT PRIMARY KEY,
        preferences_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,

  // Canonical platform object: channel_approval_references
  `CREATE TABLE channel_approval_references (
        id TEXT PRIMARY KEY,
        reference_hash TEXT NOT NULL UNIQUE,
        connection_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        bot_uuid TEXT NOT NULL,
        chat_kind TEXT NOT NULL CHECK(chat_kind IN ('person', 'group')),
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        pending_action_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(connection_id) REFERENCES langbot_connections(id) ON DELETE CASCADE,
        FOREIGN KEY(profile_id) REFERENCES channel_bot_profiles(id) ON DELETE CASCADE,
        FOREIGN KEY(account_id) REFERENCES mail_accounts(public_id) ON DELETE CASCADE
      )`,

  // Canonical platform object: channel_audit_events
  `CREATE TABLE channel_audit_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        connection_id TEXT,
        profile_id TEXT,
        account_id TEXT,
        scope_json TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(connection_id) REFERENCES langbot_connections(id) ON DELETE SET NULL,
        FOREIGN KEY(profile_id) REFERENCES channel_bot_profiles(id) ON DELETE SET NULL
      )`,

  // Canonical platform object: channel_bindings
  `CREATE TABLE channel_bindings (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        bot_uuid TEXT NOT NULL,
        platform TEXT NOT NULL CHECK(platform IN ('feishu', 'wecom')),
        chat_kind TEXT NOT NULL CHECK(chat_kind IN ('person', 'group')),
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        require_mention INTEGER NOT NULL DEFAULT 0 CHECK(require_mention IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT,
        UNIQUE(connection_id, bot_uuid, platform, chat_kind, chat_id, sender_id),
        FOREIGN KEY(connection_id) REFERENCES langbot_connections(id) ON DELETE CASCADE,
        FOREIGN KEY(profile_id) REFERENCES channel_bot_profiles(id) ON DELETE CASCADE,
        FOREIGN KEY(account_id) REFERENCES mail_accounts(public_id) ON DELETE CASCADE
      )`,

  // Canonical platform object: channel_bot_profiles
  `CREATE TABLE channel_bot_profiles (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        bot_uuid TEXT NOT NULL,
        platform TEXT NOT NULL CHECK(platform IN ('feishu', 'wecom')),
        display_name TEXT NOT NULL,
        adapter_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
        onboarding_state TEXT NOT NULL DEFAULT 'draft'
          CHECK(onboarding_state IN (
            'draft', 'gateway_verified', 'bot_selected', 'owner_pairing',
            'owner_verified', 'initialization_pending', 'ready'
          )),
        owner_binding_version INTEGER NOT NULL DEFAULT 0,
        initialization_version INTEGER,
        initialized_at TEXT,
        last_inbound_at TEXT,
        last_outbound_at TEXT,
        last_detected_at TEXT,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(connection_id, bot_uuid),
        FOREIGN KEY(connection_id) REFERENCES langbot_connections(id) ON DELETE CASCADE
      )`,

  // Canonical platform object: channel_deliveries
  `CREATE TABLE channel_deliveries (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        bot_uuid TEXT NOT NULL,
        platform TEXT NOT NULL CHECK(platform IN ('feishu', 'wecom')),
        target_type TEXT NOT NULL CHECK(target_type IN ('person', 'group')),
        target_id TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK(purpose IN (
          'agent_reply', 'initialization', 'diagnostic', 'automation',
          'access_notice', 'confirmation'
        )),
        text TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK(state IN (
            'pending', 'leased', 'retrying', 'sent', 'ambiguous', 'failed',
            'needs_reauthorization'
          )),
        sequence INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        next_attempt_at TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        correlation_key TEXT,
        automation_rule_id TEXT,
        automation_run_id TEXT,
        automation_action_index INTEGER,
        owner_binding_version INTEGER,
        response_id TEXT,
        error_code TEXT,
        fallback_targets_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT,
        FOREIGN KEY(connection_id) REFERENCES langbot_connections(id) ON DELETE CASCADE,
        FOREIGN KEY(profile_id) REFERENCES channel_bot_profiles(id) ON DELETE CASCADE
      )`,

  // Canonical platform object: channel_destinations
  `CREATE TABLE channel_destinations (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        destination_type TEXT NOT NULL CHECK(destination_type IN ('person', 'group')),
        external_id TEXT NOT NULL,
        display_name TEXT,
        verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0, 1)),
        created_at TEXT NOT NULL,
        UNIQUE(profile_id, destination_type, external_id),
        FOREIGN KEY(profile_id) REFERENCES channel_bot_profiles(id) ON DELETE CASCADE
      )`,

  // Canonical platform object: channel_inbound_events
  `CREATE TABLE channel_inbound_events (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        profile_id TEXT,
        event_uuid TEXT NOT NULL,
        bot_uuid TEXT NOT NULL,
        platform TEXT NOT NULL CHECK(platform IN ('feishu', 'wecom')),
        chat_kind TEXT NOT NULL CHECK(chat_kind IN ('person', 'group')),
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        peer_key TEXT NOT NULL,
        normalized_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'leased', 'completed', 'ignored', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(connection_id, event_uuid),
        FOREIGN KEY(connection_id) REFERENCES langbot_connections(id) ON DELETE CASCADE,
        FOREIGN KEY(profile_id) REFERENCES channel_bot_profiles(id) ON DELETE SET NULL
      )`,

  // Canonical platform object: channel_initializations
  `CREATE TABLE channel_initializations (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        owner_binding_version INTEGER NOT NULL,
        content_version INTEGER NOT NULL,
        delivery_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        UNIQUE(profile_id, owner_binding_version, content_version),
        FOREIGN KEY(profile_id) REFERENCES channel_bot_profiles(id) ON DELETE CASCADE,
        FOREIGN KEY(delivery_id) REFERENCES channel_deliveries(id) ON DELETE CASCADE
      )`,

  // Canonical platform object: channel_owner_history
  `CREATE TABLE channel_owner_history (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        bot_uuid TEXT NOT NULL,
        platform TEXT NOT NULL CHECK(platform IN ('feishu', 'wecom')),
        user_id TEXT NOT NULL,
        display_name TEXT,
        binding_version INTEGER NOT NULL,
        verified_at TEXT NOT NULL,
        revoked_at TEXT,
        FOREIGN KEY(profile_id) REFERENCES channel_bot_profiles(id) ON DELETE CASCADE,
        FOREIGN KEY(connection_id) REFERENCES langbot_connections(id) ON DELETE CASCADE
      )`,

  // Canonical platform object: channel_pairing_challenges
  `CREATE TABLE channel_pairing_challenges (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        bot_uuid TEXT NOT NULL,
        platform TEXT NOT NULL CHECK(platform IN ('feishu', 'wecom')),
        code_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        redeemed_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(profile_id) REFERENCES channel_bot_profiles(id) ON DELETE CASCADE,
        FOREIGN KEY(connection_id) REFERENCES langbot_connections(id) ON DELETE CASCADE
      )`,

  // Canonical platform object: configuration_confirmation_snapshots
  `CREATE TABLE configuration_confirmation_snapshots (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        task_revision INTEGER NOT NULL,
        account_id TEXT NOT NULL,
        pipeline_draft_id TEXT NOT NULL,
        pipeline_draft_revision INTEGER NOT NULL,
        rule_hash TEXT NOT NULL,
        skill_snapshots_json TEXT NOT NULL DEFAULT '[]',
        capability_snapshots_json TEXT NOT NULL DEFAULT '[]',
        review_hashes_json TEXT NOT NULL DEFAULT '[]',
        risk TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL, configuration_json TEXT,
        FOREIGN KEY(task_id) REFERENCES configuration_tasks(id) ON DELETE CASCADE,
        FOREIGN KEY(pipeline_draft_id) REFERENCES execution_pipeline_drafts(id) ON DELETE CASCADE
      )`,

  // Canonical platform object: configuration_task_effects
  `CREATE TABLE configuration_task_effects (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        type TEXT NOT NULL,
        state TEXT NOT NULL,
        summary TEXT NOT NULL,
        external_audit_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES configuration_tasks(id) ON DELETE CASCADE
      )`,

  // Canonical platform object: configuration_task_issues
  `CREATE TABLE configuration_task_issues (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        category TEXT NOT NULL,
        code TEXT NOT NULL,
        phase TEXT NOT NULL,
        severity TEXT NOT NULL,
        user_message TEXT NOT NULL,
        responsibility TEXT NOT NULL,
        retryability TEXT NOT NULL,
        privacy_class TEXT NOT NULL,
        affected_scope_json TEXT NOT NULL DEFAULT '[]',
        unaffected_scope_json TEXT,
        diagnostic_json TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        FOREIGN KEY(task_id) REFERENCES configuration_tasks(id) ON DELETE CASCADE
      )`,

  // Canonical platform object: configuration_task_recoveries
  `CREATE TABLE configuration_task_recoveries (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        issue_id TEXT NOT NULL,
        type TEXT NOT NULL,
        label TEXT NOT NULL,
        description TEXT,
        target TEXT,
        requires_confirmation INTEGER NOT NULL CHECK(requires_confirmation IN (0, 1)),
        dangerous INTEGER NOT NULL CHECK(dangerous IN (0, 1)),
        preferred INTEGER NOT NULL CHECK(preferred IN (0, 1)),
        resumes_from_phase TEXT,
        expires_at TEXT,
        resolved_at TEXT,
        FOREIGN KEY(task_id) REFERENCES configuration_tasks(id) ON DELETE CASCADE,
        FOREIGN KEY(issue_id) REFERENCES configuration_task_issues(id) ON DELETE CASCADE
      )`,

  // Canonical platform object: configuration_task_steps
  `CREATE TABLE configuration_task_steps (
        task_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT,
        started_at TEXT,
        completed_at TEXT,
        position INTEGER NOT NULL,
        PRIMARY KEY(task_id, step_id),
        FOREIGN KEY(task_id) REFERENCES configuration_tasks(id) ON DELETE CASCADE
      )`,

  // Canonical platform object: configuration_tasks
  `CREATE TABLE configuration_tasks (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        session_id TEXT,
        kind TEXT NOT NULL,
        target_key TEXT NOT NULL,
        operation TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        current_phase TEXT NOT NULL,
        source_surface TEXT NOT NULL,
        source_id TEXT,
        revision INTEGER NOT NULL CHECK(revision > 0),
        references_json TEXT NOT NULL DEFAULT '[]',
        authorization_json TEXT,
        retention_until TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, pipeline_draft_id TEXT, review_checkpoint_ids_json TEXT NOT NULL DEFAULT '[]', interaction_json TEXT, confirmation_snapshot_id TEXT,
        FOREIGN KEY(account_id) REFERENCES mail_accounts(public_id) ON DELETE CASCADE
      )`,

  // Canonical platform object: directory_contacts
  `CREATE TABLE directory_contacts (
        account_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        department_id TEXT,
        department_path TEXT,
        title TEXT,
        full_pinyin TEXT,
        mobile TEXT,
        company_phone TEXT,
        synced_at TEXT NOT NULL, pinyin_initials TEXT NOT NULL DEFAULT '', pinyin_index_version INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, id),
        FOREIGN KEY(account_id) REFERENCES mail_accounts(public_id) ON DELETE CASCADE
      )`,

  // Canonical platform object: directory_contacts_fts
  `CREATE VIRTUAL TABLE directory_contacts_fts USING fts5(
        account_id UNINDEXED,
        contact_id UNINDEXED,
        search_text,
        tokenize='trigram'
      )`,

  // Canonical platform object: directory_departments
  `CREATE TABLE directory_departments (
        account_id TEXT NOT NULL,
        id TEXT NOT NULL,
        parent_id TEXT,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        child_count INTEGER NOT NULL DEFAULT 0,
        synced_at TEXT NOT NULL,
        PRIMARY KEY (account_id, id),
        FOREIGN KEY(account_id) REFERENCES mail_accounts(public_id) ON DELETE CASCADE
      )`,

  // Canonical platform object: directory_sync_status
  `CREATE TABLE directory_sync_status (
        account_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        phase TEXT,
        processed_departments INTEGER NOT NULL DEFAULT 0,
        processed_contacts INTEGER NOT NULL DEFAULT 0,
        last_successful_at TEXT,
        updated_at TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        FOREIGN KEY(account_id) REFERENCES mail_accounts(public_id) ON DELETE CASCADE
      )`,

  // Canonical platform object: execution_pipeline_drafts
  `CREATE TABLE execution_pipeline_drafts (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        session_id TEXT,
        mode TEXT NOT NULL CHECK(mode IN ('one_shot', 'automation')),
        revision INTEGER NOT NULL CHECK(revision > 0),
        trigger_json TEXT,
        data_selection_json TEXT,
        analysis_recipe_json TEXT,
        artifact_recipe_json TEXT,
        delivery_plan_json TEXT,
        steps_json TEXT NOT NULL DEFAULT '[]',
        skill_snapshots_json TEXT NOT NULL DEFAULT '[]',
        capability_snapshots_json TEXT NOT NULL DEFAULT '[]',
        validation_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, owner_json TEXT, account_scope_json TEXT, source_rule_id TEXT, source_rule_version INTEGER, template_binding_json TEXT, template_configuration_json TEXT, advanced_policy_json TEXT,
        FOREIGN KEY(account_id) REFERENCES mail_accounts(public_id) ON DELETE CASCADE
      )`,

  // Canonical platform object: integration_connection_observations
  `CREATE TABLE integration_connection_observations (
        entry_key TEXT PRIMARY KEY,
        integration_id TEXT NOT NULL CHECK(integration_id IN ('wecli', 'feishu', 'wecom')),
        profile_id TEXT,
        state TEXT NOT NULL CHECK(state IN (
          'connected', 'attention', 'disconnected', 'not_configured', 'unknown'
        )),
        reason_code TEXT,
        next_action TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        observed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(profile_id) REFERENCES channel_bot_profiles(id) ON DELETE CASCADE
      )`,

  // Canonical platform object: intelligence_audit_log
  `CREATE TABLE intelligence_audit_log (
        id TEXT PRIMARY KEY,
        email_id TEXT NOT NULL,
        action TEXT NOT NULL,
        processor TEXT,
        source TEXT NOT NULL,
        session_id TEXT,
        user_id TEXT,
        result_json TEXT,
        created_at TEXT NOT NULL
      )`,

  // Canonical platform object: invoice_attachment_statuses
  `CREATE TABLE invoice_attachment_statuses (
        account_id TEXT NOT NULL,
        email_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL,
        filename TEXT,
        status TEXT NOT NULL,
        invoice_id TEXT,
        invoice_number TEXT,
        invoice_seller TEXT,
        invoice_total TEXT,
        invoice_expense_type TEXT,
        last_command TEXT,
        last_stdout TEXT,
        last_stderr TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, email_id, attachment_id))`,

  // Canonical platform object: langbot_connections
  `CREATE TABLE langbot_connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        compatibility_profile TEXT NOT NULL,
        api_secret_ref TEXT NOT NULL,
        webhook_secret_ref TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
        trust_mode TEXT NOT NULL CHECK(trust_mode IN ('loopback', 'remote')),
        compatibility_state TEXT NOT NULL DEFAULT 'unknown'
          CHECK(compatibility_state IN ('unknown', 'compatible', 'incompatible')),
        last_checked_at TEXT,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,

  // Canonical platform object: llm_settings
  `CREATE TABLE llm_settings (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        base_url TEXT,
        default_model TEXT NOT NULL,
        summary_model TEXT,
        draft_model TEXT,
        agent_model TEXT,
        reasoning_effort TEXT,
        free_trial INTEGER NOT NULL DEFAULT 0,
        free_trial_base_url TEXT,
        free_trial_model TEXT,
        free_trial_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,

  // Canonical platform object: mcp_access_tokens
  `CREATE TABLE mcp_access_tokens (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        secret_key TEXT NOT NULL UNIQUE,
        fingerprint TEXT NOT NULL UNIQUE,
        verifier_salt TEXT NOT NULL,
        verifier_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT, credential_kind TEXT NOT NULL DEFAULT 'legacy'
        CHECK(credential_kind IN ('legacy', 'managed')),
        FOREIGN KEY(account_id) REFERENCES mail_accounts(public_id) ON DELETE CASCADE
      )`,

  // Canonical platform object: mcp_audit_events
  `CREATE TABLE mcp_audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        token_fingerprint TEXT,
        session_hash TEXT,
        tool_name TEXT NOT NULL,
        account_id TEXT,
        risk_class TEXT NOT NULL,
        argument_shape_json TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        outcome_code TEXT NOT NULL,
        response_bytes INTEGER NOT NULL DEFAULT 0,
        operation_id TEXT,
        idempotency_key_hash TEXT
      )`,

  // Canonical platform object: mcp_idempotency_reservations
  `CREATE TABLE mcp_idempotency_reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        dispatch_state TEXT NOT NULL CHECK(dispatch_state IN ('reserved', 'dispatching', 'succeeded', 'failed_retryable', 'outcome_unknown')),
        result_code TEXT,
        result_summary_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(account_id, key_hash),
        UNIQUE(operation_id, key_hash),
        FOREIGN KEY(account_id) REFERENCES mail_accounts(public_id) ON DELETE CASCADE,
        FOREIGN KEY(operation_id) REFERENCES mcp_prepared_operations(id) ON DELETE CASCADE
      )`,

  // Canonical platform object: mcp_prepared_operations
  `CREATE TABLE mcp_prepared_operations (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        token_id TEXT,
        session_hash TEXT,
        operation_type TEXT NOT NULL CHECK(operation_type IN ('send', 'mail_action', 'delete_draft', 'delete_todo')),
        risk TEXT NOT NULL DEFAULT 'high' CHECK(risk = 'high'),
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        preview TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('prepared', 'awaiting_confirmation', 'approved', 'committing', 'succeeded', 'failed_retryable', 'cancelled', 'expired', 'outcome_unknown')),
        expires_at TEXT NOT NULL,
        approved_at TEXT,
        approval_event_id TEXT,
        result_code TEXT,
        result_summary_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(account_id) REFERENCES mail_accounts(public_id) ON DELETE CASCADE,
        FOREIGN KEY(token_id) REFERENCES mcp_access_tokens(id) ON DELETE SET NULL
      )`,

  // Canonical platform object: mcp_settings
  `CREATE TABLE "mcp_settings" (
        id TEXT PRIMARY KEY CHECK(id = 'default'),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
        port INTEGER NOT NULL DEFAULT 43129 CHECK(port BETWEEN 1 AND 65535),
        default_body_characters INTEGER NOT NULL DEFAULT 6000 CHECK(default_body_characters BETWEEN 1 AND 1000000),
        max_body_characters INTEGER NOT NULL DEFAULT 20000 CHECK(max_body_characters BETWEEN 1 AND 1000000),
        default_page_size INTEGER NOT NULL DEFAULT 25 CHECK(default_page_size BETWEEN 1 AND 1000),
        max_page_size INTEGER NOT NULL DEFAULT 100 CHECK(max_page_size BETWEEN 1 AND 1000),
        max_recipients INTEGER NOT NULL DEFAULT 200 CHECK(max_recipients BETWEEN 1 AND 1000),
        max_batch_messages INTEGER NOT NULL DEFAULT 100 CHECK(max_batch_messages BETWEEN 1 AND 1000),
        max_pending_operations INTEGER NOT NULL DEFAULT 100 CHECK(max_pending_operations BETWEEN 1 AND 10000),
        tool_timeout_seconds INTEGER NOT NULL DEFAULT 30 CHECK(tool_timeout_seconds BETWEEN 1 AND 600),
        updated_at TEXT NOT NULL
      )`,

  // Canonical platform object: message_artifact_resources
  `CREATE TABLE message_artifact_resources (
        artifact_id TEXT NOT NULL,
        artifact_version INTEGER NOT NULL,
        name TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        PRIMARY KEY(artifact_id, artifact_version, name),
        FOREIGN KEY(artifact_id, artifact_version) REFERENCES message_artifacts(id, version) ON DELETE CASCADE
      )`,

  // Canonical platform object: message_artifacts
  `CREATE TABLE message_artifacts (
        id TEXT NOT NULL,
        version INTEGER NOT NULL,
        account_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        preview TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        preview_only INTEGER NOT NULL DEFAULT 0,
        source_rule_id TEXT,
        source_rule_version INTEGER,
        source_run_id TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT, owner_type TEXT NOT NULL DEFAULT 'account'
      CHECK(owner_type IN ('account', 'local_profile')), owner_profile_id TEXT,
        PRIMARY KEY(id, version)
      )`,

  // Canonical platform object: pipeline_review_checkpoints
  `CREATE TABLE pipeline_review_checkpoints (
        id TEXT PRIMARY KEY,
        pipeline_id TEXT NOT NULL,
        target TEXT NOT NULL CHECK(target IN ('data', 'analysis', 'artifact', 'delivery')),
        policy TEXT NOT NULL CHECK(policy IN ('none', 'recommended', 'required')),
        status TEXT NOT NULL CHECK(status IN ('pending', 'accepted', 'rejected', 'stale')),
        draft_revision INTEGER NOT NULL,
        target_version INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        preview_id TEXT,
        preview_url TEXT,
        depends_on_json TEXT NOT NULL DEFAULT '[]',
        feedback TEXT,
        accepted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(pipeline_id) REFERENCES execution_pipeline_drafts(id) ON DELETE CASCADE
      )`,

  // Canonical platform object: skill_dependencies
  `CREATE TABLE skill_dependencies (
        skill_id TEXT NOT NULL,
        skill_version TEXT NOT NULL,
        dependency_skill_id TEXT NOT NULL,
        dependency_version TEXT,
        optional INTEGER NOT NULL DEFAULT 0 CHECK(optional IN (0, 1)),
        PRIMARY KEY(skill_id, skill_version, dependency_skill_id),
        FOREIGN KEY(skill_id, skill_version)
          REFERENCES skill_versions(skill_id, version) ON DELETE CASCADE
      )`,

  // Canonical platform object: skill_drafts
  `CREATE TABLE skill_drafts (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK(status IN ('draft', 'validated', 'awaiting_confirmation', 'installed', 'rejected')),
        display_name TEXT NOT NULL,
        description TEXT NOT NULL,
        skill_markdown TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        validation_issues_json TEXT NOT NULL DEFAULT '[]',
        content_hash TEXT NOT NULL,
        source_session_id TEXT,
        source_pipeline_id TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,

  // Canonical platform object: skill_packages
  `CREATE TABLE skill_packages (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK(scope IN ('builtin', 'personal')),
        display_name TEXT NOT NULL,
        description TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('application', 'import', 'agent', 'manual')),
        active_version TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        protected INTEGER NOT NULL DEFAULT 0 CHECK(protected IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,

  // Canonical platform object: skill_usage_references
  `CREATE TABLE skill_usage_references (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        skill_version TEXT NOT NULL,
        reference_type TEXT NOT NULL
          CHECK(reference_type IN ('automation_rule', 'configuration_task', 'agent_session', 'pipeline_draft')),
        reference_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(skill_id, skill_version, reference_type, reference_id),
        FOREIGN KEY(skill_id, skill_version)
          REFERENCES skill_versions(skill_id, version) ON DELETE RESTRICT
      )`,

  // Canonical platform object: skill_versions
  `CREATE TABLE skill_versions (
        skill_id TEXT NOT NULL,
        version TEXT NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('builtin', 'personal')),
        package_path TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        compatibility TEXT NOT NULL
          CHECK(compatibility IN ('compatible', 'partially_compatible', 'incompatible', 'tampered')),
        compatibility_issues_json TEXT NOT NULL DEFAULT '[]',
        installed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(skill_id, version),
        FOREIGN KEY(skill_id) REFERENCES skill_packages(id) ON DELETE CASCADE
      )`,

  // Canonical platform object: wecli_audit_logs
  `CREATE TABLE wecli_audit_logs (
        id TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        args_json TEXT NOT NULL,
        approval_status TEXT NOT NULL,
        exit_code INTEGER,
        stdout TEXT,
        stderr TEXT,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      )`,

  // Canonical platform object: writing_styles
  `CREATE TABLE writing_styles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        instructions TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,

  // Canonical platform object: idx_agent_conversations_archived
  `CREATE INDEX idx_agent_conversations_archived
      ON agent_conversations(archived_at, updated_at DESC)`,

  // Canonical platform object: idx_agent_conversations_pinned
  `CREATE INDEX idx_agent_conversations_pinned
      ON agent_conversations(pinned_at, updated_at DESC)`,

  // Canonical platform object: idx_agent_messages_conversation
  `CREATE INDEX idx_agent_messages_conversation
      ON agent_messages(conversation_id, created_at)`,

  // Canonical platform object: idx_agent_pending_actions_account_status
  `CREATE INDEX idx_agent_pending_actions_account_status
      ON agent_pending_actions(account_id, status, created_at DESC)`,

  // Canonical platform object: idx_agent_pending_actions_mcp_operation
  `CREATE UNIQUE INDEX idx_agent_pending_actions_mcp_operation
      ON agent_pending_actions(mcp_operation_id)
      WHERE mcp_operation_id IS NOT NULL`,

  // Canonical platform object: idx_agent_pending_actions_owner
  `CREATE INDEX idx_agent_pending_actions_owner
      ON agent_pending_actions(
        owner_type, owner_profile_id, account_id, status, created_at DESC
      )`,

  // Canonical platform object: idx_agent_pending_actions_risk_level
  `CREATE INDEX idx_agent_pending_actions_risk_level
      ON agent_pending_actions(risk_level)`,

  // Canonical platform object: idx_agent_pending_actions_status
  `CREATE INDEX idx_agent_pending_actions_status
      ON agent_pending_actions(status, created_at DESC)`,

  // Canonical platform object: idx_ai_usage_account_category
  `CREATE INDEX idx_ai_usage_account_category
      ON ai_usage(account_id, category, created_at DESC)`,

  // Canonical platform object: idx_ai_usage_processor
  `CREATE INDEX idx_ai_usage_processor
      ON ai_usage(processor, created_at DESC)`,

  // Canonical platform object: idx_application_messages_account_created
  `CREATE INDEX idx_application_messages_account_created
      ON application_messages(account_id, archived_at, created_at DESC)`,

  // Canonical platform object: idx_application_messages_owner
  `CREATE INDEX idx_application_messages_owner
      ON application_messages(owner_type, owner_profile_id, account_id, created_at DESC)`,

  // Canonical platform object: idx_application_messages_rule_run
  `CREATE UNIQUE INDEX idx_application_messages_rule_run
      ON application_messages(source_rule_id, source_run_id)
      WHERE source_rule_id IS NOT NULL AND source_run_id IS NOT NULL`,

  // Canonical platform object: idx_automation_deferred_due
  `CREATE INDEX idx_automation_deferred_due
      ON automation_deferred_executions(account_id, status, due_at, next_attempt_at)`,

  // Canonical platform object: idx_automation_deferred_unique
  `CREATE UNIQUE INDEX idx_automation_deferred_unique
      ON automation_deferred_executions(rule_id, rule_version, email_id)`,

  // Canonical platform object: idx_automation_manifest_items_account_reference
  `CREATE INDEX idx_automation_manifest_items_account_reference
      ON automation_run_manifest_items(account_id, reference_type, reference_id)`,

  // Canonical platform object: idx_automation_result_envelopes_run
  `CREATE INDEX idx_automation_result_envelopes_run
      ON automation_result_envelopes(run_id, created_at DESC)`,

  // Canonical platform object: idx_automation_rule_previews_account_expiry
  `CREATE INDEX idx_automation_rule_previews_account_expiry
      ON automation_rule_previews(account_id, expires_at)`,

  // Canonical platform object: idx_automation_rule_references_target
  `CREATE INDEX idx_automation_rule_references_target
      ON automation_rule_references(reference_type, reference_id)`,

  // Canonical platform object: idx_automation_rule_runs_occurrence_revision
  `CREATE UNIQUE INDEX idx_automation_rule_runs_occurrence_revision
      ON automation_rule_runs(rule_id, planned_occurrence_key, run_revision)
      WHERE planned_occurrence_key IS NOT NULL`,

  // Canonical platform object: idx_automation_rule_runs_status_created
  `CREATE INDEX idx_automation_rule_runs_status_created
      ON automation_rule_runs(account_id, status, created_at DESC)`,

  // Canonical platform object: idx_automation_rule_runs_trigger_key
  `CREATE UNIQUE INDEX idx_automation_rule_runs_trigger_key
      ON automation_rule_runs(rule_id, trigger_key)`,

  // Canonical platform object: idx_automation_rule_versions_account
  `CREATE INDEX idx_automation_rule_versions_account
      ON automation_rule_versions(account_id, rule_id, version DESC)`,

  // Canonical platform object: idx_automation_rules_account
  `CREATE INDEX idx_automation_rules_account
      ON automation_rules(account_id, enabled)`,

  // Canonical platform object: idx_automation_rules_owner
  `CREATE INDEX idx_automation_rules_owner
      ON automation_rules(owner_type, owner_profile_id, account_id, archived_at)`,

  // Canonical platform object: idx_automation_rules_profile_identity
  `CREATE UNIQUE INDEX idx_automation_rules_profile_identity
      ON automation_rules(owner_profile_id, id)
      WHERE owner_type = 'local_profile'`,

  // Canonical platform object: idx_automation_rules_template
  `CREATE INDEX idx_automation_rules_template
      ON automation_rules(template_id, template_version, archived_at)`,

  // Canonical platform object: idx_automation_step_runs_retention
  `CREATE INDEX idx_automation_step_runs_retention
      ON automation_step_runs(expires_at, retention_class)`,

  // Canonical platform object: idx_automation_step_runs_run
  `CREATE INDEX idx_automation_step_runs_run
      ON automation_step_runs(run_id, step_id)`,

  // Canonical platform object: idx_automation_template_previews_account_expiry
  `CREATE INDEX idx_automation_template_previews_account_expiry
      ON automation_template_previews(account_id, expires_at)`,

  // Canonical platform object: idx_automation_template_versions_active
  `CREATE INDEX idx_automation_template_versions_active
      ON automation_template_versions(template_id, active, version)`,

  // Canonical platform object: idx_automation_template_versions_hash
  `CREATE UNIQUE INDEX idx_automation_template_versions_hash
      ON automation_template_versions(template_id, content_hash)`,

  // Canonical platform object: idx_channel_bindings_account
  `CREATE INDEX idx_channel_bindings_account
      ON channel_bindings(account_id, enabled)`,

  // Canonical platform object: idx_channel_bot_profiles_platform
  `CREATE INDEX idx_channel_bot_profiles_platform
      ON channel_bot_profiles(platform, enabled, onboarding_state)`,

  // Canonical platform object: idx_channel_delivery_correlation_sequence
  `CREATE UNIQUE INDEX idx_channel_delivery_correlation_sequence
      ON channel_deliveries(correlation_key, sequence)
      WHERE correlation_key IS NOT NULL`,

  // Canonical platform object: idx_channel_delivery_work
  `CREATE INDEX idx_channel_delivery_work
      ON channel_deliveries(state, next_attempt_at, lease_expires_at, created_at)`,

  // Canonical platform object: idx_channel_inbound_work
  `CREATE INDEX idx_channel_inbound_work
      ON channel_inbound_events(status, next_attempt_at, lease_expires_at, created_at)`,

  // Canonical platform object: idx_channel_owner_one_active
  `CREATE UNIQUE INDEX idx_channel_owner_one_active
      ON channel_owner_history(profile_id)
      WHERE revoked_at IS NULL`,

  // Canonical platform object: idx_channel_owner_version
  `CREATE UNIQUE INDEX idx_channel_owner_version
      ON channel_owner_history(profile_id, binding_version)`,

  // Canonical platform object: idx_channel_pairing_active
  `CREATE INDEX idx_channel_pairing_active
      ON channel_pairing_challenges(profile_id, expires_at, redeemed_at)`,

  // Canonical platform object: idx_configuration_task_issues_active
  `CREATE INDEX idx_configuration_task_issues_active
      ON configuration_task_issues(task_id, resolved_at, created_at)`,

  // Canonical platform object: idx_configuration_tasks_account_updated
  `CREATE INDEX idx_configuration_tasks_account_updated
      ON configuration_tasks(account_id, updated_at DESC)`,

  // Canonical platform object: idx_configuration_tasks_one_active
  `CREATE UNIQUE INDEX idx_configuration_tasks_one_active
      ON configuration_tasks(account_id, kind, target_key, operation)
      WHERE status NOT IN ('completed', 'completed_with_warnings', 'failed', 'cancelled')`,

  // Canonical platform object: idx_directory_contacts_department
  `CREATE INDEX idx_directory_contacts_department
      ON directory_contacts(account_id, department_id, name)`,

  // Canonical platform object: idx_directory_contacts_email
  `CREATE UNIQUE INDEX idx_directory_contacts_email
      ON directory_contacts(account_id, email COLLATE NOCASE)`,

  // Canonical platform object: idx_directory_departments_parent
  `CREATE INDEX idx_directory_departments_parent
      ON directory_departments(account_id, parent_id, name)`,

  // Canonical platform object: idx_execution_pipeline_drafts_account_updated
  `CREATE INDEX idx_execution_pipeline_drafts_account_updated
      ON execution_pipeline_drafts(account_id, updated_at DESC)`,

  // Canonical platform object: idx_execution_pipeline_drafts_source_rule
  `CREATE UNIQUE INDEX idx_execution_pipeline_drafts_source_rule
      ON execution_pipeline_drafts(account_id, source_rule_id)
      WHERE source_rule_id IS NOT NULL`,

  // Canonical platform object: idx_integration_observations_integration
  `CREATE INDEX idx_integration_observations_integration
      ON integration_connection_observations(integration_id, observed_at DESC)`,

  // Canonical platform object: idx_intelligence_audit_email
  `CREATE INDEX idx_intelligence_audit_email
      ON intelligence_audit_log(email_id, created_at DESC)`,

  // Canonical platform object: idx_intelligence_audit_source
  `CREATE INDEX idx_intelligence_audit_source
      ON intelligence_audit_log(source, created_at DESC)`,

  // Canonical platform object: idx_invoice_attachment_statuses_email
  `CREATE INDEX idx_invoice_attachment_statuses_email
      ON invoice_attachment_statuses(email_id)`,

  // Canonical platform object: idx_invoice_attachment_statuses_invoice_id
  `CREATE INDEX idx_invoice_attachment_statuses_invoice_id
      ON invoice_attachment_statuses(account_id, invoice_id)
      WHERE invoice_id IS NOT NULL`,

  // Canonical platform object: idx_invoice_attachment_statuses_status
  `CREATE INDEX idx_invoice_attachment_statuses_status
      ON invoice_attachment_statuses(account_id, status)`,

  // Canonical platform object: idx_mcp_access_tokens_account_kind_status
  `CREATE INDEX idx_mcp_access_tokens_account_kind_status
      ON mcp_access_tokens(account_id, credential_kind, status, created_at DESC)`,

  // Canonical platform object: idx_mcp_access_tokens_account_status
  `CREATE INDEX idx_mcp_access_tokens_account_status
      ON mcp_access_tokens(account_id, status, created_at DESC)`,

  // Canonical platform object: idx_mcp_access_tokens_one_active_managed
  `CREATE UNIQUE INDEX idx_mcp_access_tokens_one_active_managed
      ON mcp_access_tokens(account_id)
      WHERE credential_kind = 'managed' AND status = 'active'
    `,

  // Canonical platform object: idx_mcp_audit_events_account_tool
  `CREATE INDEX idx_mcp_audit_events_account_tool
      ON mcp_audit_events(account_id, tool_name, occurred_at DESC)`,

  // Canonical platform object: idx_mcp_audit_events_occurred
  `CREATE INDEX idx_mcp_audit_events_occurred
      ON mcp_audit_events(occurred_at)`,

  // Canonical platform object: idx_mcp_idempotency_operation_state
  `CREATE INDEX idx_mcp_idempotency_operation_state
      ON mcp_idempotency_reservations(operation_id, dispatch_state)`,

  // Canonical platform object: idx_mcp_prepared_operations_account_state
  `CREATE INDEX idx_mcp_prepared_operations_account_state
      ON mcp_prepared_operations(account_id, state, expires_at)`,

  // Canonical platform object: idx_mcp_prepared_operations_token_created
  `CREATE INDEX idx_mcp_prepared_operations_token_created
      ON mcp_prepared_operations(token_id, created_at DESC)`,

  // Canonical platform object: idx_message_artifacts_account_created
  `CREATE INDEX idx_message_artifacts_account_created
      ON message_artifacts(account_id, created_at DESC)`,

  // Canonical platform object: idx_message_artifacts_owner
  `CREATE INDEX idx_message_artifacts_owner
      ON message_artifacts(owner_type, owner_profile_id, account_id, created_at DESC)`,

  // Canonical platform object: idx_pipeline_reviews_pipeline_target
  `CREATE INDEX idx_pipeline_reviews_pipeline_target
      ON pipeline_review_checkpoints(pipeline_id, target, updated_at DESC)`,

  // Canonical platform object: idx_skill_usage_reference_target
  `CREATE INDEX idx_skill_usage_reference_target
      ON skill_usage_references(reference_type, reference_id)`,

  // Canonical platform object: idx_skill_versions_hash
  `CREATE UNIQUE INDEX idx_skill_versions_hash
      ON skill_versions(skill_id, content_hash)`,
] as const;
