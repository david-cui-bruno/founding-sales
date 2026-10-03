-- ---------------------------------------------------------------------------
-- 0040_meeting_booking_details.sql — what a booking tells us besides its times (lane M2)
-- changes: meetings
--
-- Cal.com's webhook and its API both carry the booking's title, the attendee's name, the
-- notes the booker typed, the booking form's answers and where the meeting happens; none
-- of it was kept. The meeting brief (`meetings/brief.ts`) reads it, and lane M3 needs the
-- Zoom meeting id to turn on local recording for a demo.
--
-- ## Columns (all nullable; null until a delivery or a reconciliation read says them)
--
--   * `event_title` — the booking's `title` (at most 300 characters).
--   * `attendee_name` — the first attendee's `name`, the attendee whose address the meeting
--     keeps (at most 200).
--   * `booking_notes` — the booker's notes: `additionalNotes`, else `description`, else the
--     `notes` response (at most 4,000).
--   * `booking_answers` — the booking form's other answers, question → answer, text only:
--     each answer at most 1,000 characters, the whole at most 8 KB as PostgreSQL prints it
--     (`booking_answers::text`, which the writer measures the same way). Cal.com's default
--     contact fields, and any question whose field or label names a phone, an e-mail, a
--     name or an address, are not answers and are never stored here.
--   * `location_type` — `videoCallData.type` (`zoom_video`, …), an app location
--     (`integrations:…`), `link` or `other` (at most 80).
--   * `video_call_url` — the video call's https URL WITHOUT its query or fragment: a Zoom
--     join URL carries its passcode as `?pwd=`, and no passcode is stored.
--   * `zoom_meeting_id` — Zoom's meeting id, digits only: `videoCallData.id` when the
--     location is Zoom, else read from a Zoom join URL.
--   * `details_observed_at` — the source time of the delivery or reconciliation read that
--     last set them (review M2R): set exactly when any detail is.
--
-- They have their own freshness. A source at least as new as `details_observed_at` replaces
-- them (a field it does not carry is kept, and a location it names replaces all three
-- conferencing fields when the kind of location changed); an older source only fills empty
-- fields. They follow the current booking through a reschedule and a fold of duplicate
-- rows, and go with the meeting row: a deletion that removes the meeting removes them
-- (`retention/deletion.ts`). `calcom_events` keeps no payload, so nothing else holds them.
--
-- ## Release shape
--
-- New nullable columns and checks on them only; no row is rewritten. The classifier calls
-- any ALTER TABLE on an existing table `touches-existing`, so the release rehearses it. The
-- table's grants (0028) cover the columns, and an older binary never writes them.
-- ---------------------------------------------------------------------------

ALTER TABLE meetings
  ADD COLUMN event_title text
    CONSTRAINT meetings_event_title_bounded CHECK (char_length(event_title) BETWEEN 1 AND 300),
  ADD COLUMN attendee_name text
    CONSTRAINT meetings_attendee_name_bounded CHECK (char_length(attendee_name) BETWEEN 1 AND 200),
  ADD COLUMN booking_notes text
    CONSTRAINT meetings_booking_notes_bounded CHECK (char_length(booking_notes) BETWEEN 1 AND 4000),
  ADD COLUMN booking_answers jsonb
    -- An object of text answers, at most 8 KB as text. The 1,000-character bound on each
    -- answer is the writer's (`meetings/bookingDetails.ts`), within this total.
    CONSTRAINT meetings_booking_answers_shape CHECK (
      jsonb_typeof(booking_answers) = 'object'
      AND booking_answers <> '{}'::jsonb
      AND NOT jsonb_path_exists(booking_answers, '$.* ? (@.type() != "string")')
      AND octet_length(booking_answers::text) <= 8192
    ),
  ADD COLUMN location_type text
    CONSTRAINT meetings_location_type_bounded CHECK (char_length(location_type) BETWEEN 1 AND 80),
  ADD COLUMN video_call_url text
    CONSTRAINT meetings_video_call_url_shape CHECK (
      char_length(video_call_url) <= 2048
      AND video_call_url ~ '^https://[^?#[:space:]]+$'
    ),
  ADD COLUMN zoom_meeting_id text
    CONSTRAINT meetings_zoom_meeting_id_shape CHECK (zoom_meeting_id ~ '^[0-9]{9,12}$'),
  ADD COLUMN details_observed_at timestamptz,
  ADD CONSTRAINT meetings_details_observed
    CHECK ((details_observed_at IS NOT NULL) = (event_title IS NOT NULL OR attendee_name IS NOT NULL OR booking_notes IS NOT NULL
             OR booking_answers IS NOT NULL OR location_type IS NOT NULL OR video_call_url IS NOT NULL OR zoom_meeting_id IS NOT NULL));
