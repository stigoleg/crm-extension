(function (root) {
  'use strict';
  const NS = (root.SNCRM = root.SNCRM || {});

  /* Registry keys match the actual ServiceNow column `name` attributes on the
   * form. This lets the `extract-by-name` strategy locate a field with a
   * single querySelector(`[name="…"]`) — far more reliable than label-text
   * matching.
   *
   * The static catalog below serves three jobs:
   *   1. Default selection + fresh-install fallback for the options page.
   *   2. Curated label/alias/renderAs hints that survive live detection
   *      (`markdown`, date, `badge-list`, `link`, `number`).
   *   3. Group fallback when the live form does not expose a section.
   *
   * The live form is the source of truth for which fields exist and which
   * section they belong to: `refreshDiscoveredFields` folds `reason: 'known'`
   * discoveries over the static entries so the detected section heading wins,
   * and appends genuinely new fields under their `detected:*` keys.
   *
   * `renderAs: 'markdown'` marks long-form fields that render as a wide
   * markdown block below the grid.
   */
  const RAW_FIELDS = [
    // Opportunity Information
    { key: 'account',                        label: 'Account',                      aliases: ['account'],                        group: 'Opportunity Information' },
    { key: 'opportunity_name',               label: 'Opportunity Name',             aliases: ['opportunity name', 'name'],        group: 'Opportunity Information' },
    { key: 'stage',                          label: 'Stage',                         aliases: ['stage', 'sales stage'],            group: 'Opportunity Information' },
    { key: 'status',                         label: 'Status',                        aliases: ['status'],                          group: 'Opportunity Information' },
    { key: 'due_date',                       label: 'Due Date',                      aliases: ['due date'],                        group: 'Opportunity Information',  renderAs: 'date' },
    { key: 'close_date',                     label: 'Close Date',                    aliases: ['close date', 'expected close'],    group: 'Opportunity Information',  renderAs: 'date' },
    { key: 'type',                           label: 'Type',                          aliases: ['type'],                            group: 'Opportunity Information' },
    { key: 'probability',                    label: 'Probability',                   aliases: ['probability'],                     group: 'Opportunity Information' },
    { key: 'strategic_partner',              label: 'Strategic Partner',             aliases: ['strategic partner'],               group: 'Opportunity Information' },
    { key: 'do_we_use_broker',               label: 'Do We Use Broker',              aliases: ['do we use broker', 'use broker'],  group: 'Opportunity Information' },
    { key: 'opportunity_owner',              label: 'Opportunity Owner',             aliases: ['opportunity owner', 'owner'],      group: 'Opportunity Information' },
    { key: 'bid_office_owner',               label: 'Bid Office Owner',              aliases: ['bid office owner'],                group: 'Opportunity Information' },
    { key: 'opportunity_contact',            label: 'Opportunity Contact',           aliases: ['opportunity contact', 'contact'],  group: 'Opportunity Information' },
    { key: 'business_unit',                  label: 'Business Unit',                 aliases: ['business unit'],                   group: 'Opportunity Information' },
    { key: 'bu_lead',                        label: 'BU Lead',                       aliases: ['bu lead', 'business unit lead'],   group: 'Opportunity Information',  renderAs: 'badge' },
    { key: 'communities',                    label: 'Communities',                   aliases: ['communities'],                     group: 'Opportunity Information',  renderAs: 'badge-list' },
    { key: 'region',                         label: 'Region',                        aliases: ['region'],                          group: 'Opportunity Information' },
    { key: 'contract_category',              label: 'Contract Category',             aliases: ['contract category'],               group: 'Opportunity Information' },
    { key: 'price_delivery_model',           label: 'Price Delivery Model',          aliases: ['price delivery model'],            group: 'Opportunity Information' },
    { key: 'bid_room',                       label: 'Bid Room',                      aliases: ['bid room'],                        group: 'Opportunity Information',   renderAs: 'link' },

    // Description
    { key: 'description',                    label: 'Description',                   aliases: ['description'],                     group: 'Description',               renderAs: 'markdown' },
    { key: 'next_step',                      label: 'Next Step',                     aliases: ['next step', 'next steps'],         group: 'Description',               renderAs: 'markdown' },

    // Opportunity Estimates
    { key: 'workload',                       label: 'Workload',                      aliases: ['workload'],                        group: 'Opportunity Estimates', renderAs: 'number' },
    { key: 'assignment_start_date',          label: 'Assignment Start Date',         aliases: ['assignment start date'],           group: 'Opportunity Estimates', renderAs: 'date' },
    { key: 'assignment_end_date',            label: 'Assignment End Date',           aliases: ['assignment end date'],             group: 'Opportunity Estimates', renderAs: 'date' },
    { key: 'extension_date',                 label: 'Extension Date',                aliases: ['extension date'],                  group: 'Opportunity Estimates', renderAs: 'date' },
    { key: 'assignment_amount',              label: 'Assignment Amount',             aliases: ['assignment amount'],               group: 'Opportunity Estimates', renderAs: 'number' },
    { key: 'weighted_assignment_amount',     label: 'Weighted Assignment Amount',    aliases: ['weighted assignment amount'],      group: 'Opportunity Estimates', renderAs: 'number' },
    { key: 'vendor_count',                   label: 'Vendor Count',                  aliases: ['vendor count', '# vendors'],       group: 'Opportunity Estimates', renderAs: 'number' },
    { key: 'years_count',                    label: '# Years',                       aliases: ['years count', '# years', 'years'], group: 'Opportunity Estimates', renderAs: 'number' },
    { key: 'estimated_value_sopra',          label: 'Estimated Value Sopra',         aliases: ['estimated value sopra'],           group: 'Opportunity Estimates', renderAs: 'number' },
    { key: 'weighted_amount_sopra',          label: 'Weighted Amount Sopra',         aliases: ['weighted amount sopra', 'estimated value sopra'], group: 'Opportunity Estimates', renderAs: 'number' },
    { key: 'yearly_estimated_value',         label: 'Yearly Estimated Value',        aliases: ['yearly estimated value'],          group: 'Opportunity Estimates', renderAs: 'number' },
    { key: 'tcv',                            label: 'TCV',                           aliases: ['tcv'],                             group: 'Opportunity Estimates', renderAs: 'number' },
    { key: 'weighted_gross_amount_tvc',      label: 'Weighted Gross Amount TCV',     aliases: ['weighted gross amount tvc', 'weighted gross amount tcv'], group: 'Opportunity Estimates', renderAs: 'number' },
    { key: 'location',                       label: 'Location',                      aliases: ['location'],                        group: 'Opportunity Estimates' },
    { key: 'days_onsite_per_week',           label: 'Days Onsite Per Week',          aliases: ['days onsite per week'],            group: 'Opportunity Estimates' },

    // APPS Status
    { key: 'active_apps_bid',                label: 'Active APPS Bid',               aliases: ['active apps bid'],                 group: 'APPS Status' },
    { key: 'apps_status',                    label: 'APPS Status',                   aliases: ['apps status', 'app status'],       group: 'APPS Status' },
    { key: 'apps_client_developer',          label: 'APPS Client Developer',         aliases: ['apps client developer', 'apps client owner', 'client developer'], group: 'APPS Status' },
    { key: 'apps_opportunity_manager',       label: 'APPS Opportunity Manager',      aliases: ['apps opportunity manager'],        group: 'APPS Status' },
    { key: 'apps_opportunity_team',          label: 'APPS Opportunity Team',         aliases: ['apps opportunity team'],           group: 'APPS Status' },
    { key: 'fast_bid',                       label: 'Fast Bid',                      aliases: ['fast bid'],                        group: 'APPS Status' },
    { key: 'apps_market_offering',           label: 'APPS Market Offering',          aliases: ['apps market offering'],            group: 'APPS Status' },
    { key: 'apps_community',                 label: 'APPS Community',                aliases: ['apps community'],                  group: 'APPS Status',              renderAs: 'badge-list' },
    { key: 'apps_funnel',                    label: 'APPS Funnel',                   aliases: ['apps funnel'],                     group: 'APPS Status' },

    // DPS Status
    { key: 'dps_client_developer',           label: 'DPS Client Developer',          aliases: ['dps client developer'],            group: 'DPS Status' },
    { key: 'dps_bid_manager',                label: 'DPS Bid Manager',               aliases: ['dps bid manager'],                 group: 'DPS Status' },
    { key: 'dps_community',                  label: 'DPS Community',                 aliases: ['dps community'],                   group: 'DPS Status',               renderAs: 'badge-list' },
    { key: 'dps_go2market',                  label: 'DPS Go2Market',                 aliases: ['dps go2market'],                   group: 'DPS Status' },

    // Advisory Status
    { key: 'advisory_client_developer',      label: 'Advisory Client Developer',     aliases: ['advisory client developer'],       group: 'Advisory Status' },
    { key: 'advisory_secondary_owner',       label: 'Advisory Secondary Owner',      aliases: ['advisory secondary owner'],        group: 'Advisory Status' },
    { key: 'advisory_bid_manager',           label: 'Advisory Bid Manager',          aliases: ['advisory bid manager'],            group: 'Advisory Status' },
    { key: 'advisory_status',                label: 'Advisory Status',               aliases: ['advisory status'],                 group: 'Advisory Status' },
    { key: 'advisory_proactive_opportunity', label: 'Advisory Proactive Opportunity',aliases: ['advisory proactive opportunity'],  group: 'Advisory Status' },
    { key: 'advisory_go2market_offering',    label: 'Advisory Go2Market Offering',   aliases: ['advisory go2market offering'],     group: 'Advisory Status' },
    { key: 'advisory_community',             label: 'Advisory Community',            aliases: ['advisory community'],              group: 'Advisory Status',          renderAs: 'badge-list' },
    { key: 'advisory_priority',              label: 'Advisory Priority',             aliases: ['advisory priority'],               group: 'Advisory Status' },

    // System Information
    { key: 'number',                         label: 'Number',                        aliases: ['number'],                          group: 'System Information' },
    { key: 'sys_created_on',                 label: 'Created',                       aliases: ['created', 'created on', 'sys created on'], group: 'System Information' },
    { key: 'sys_created_by',                 label: 'Created By',                    aliases: ['created by', 'sys created by'],    group: 'System Information' },
    { key: 'sys_updated_on',                 label: 'Updated',                       aliases: ['updated', 'updated on', 'sys updated on'], group: 'System Information' },
    { key: 'sys_updated_by',                 label: 'Updated By',                    aliases: ['updated by', 'sys updated by'],    group: 'System Information' },
    { key: 'source',                         label: 'Source',                        aliases: ['source'],                          group: 'System Information' }
  ];

  function escapeCssIdentifier(value) {
    const raw = String(value || '');
    if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') {
      return CSS.escape(raw);
    }
    return raw.replace(/["\\]/g, '\\$&');
  }

  function normalizeLabel(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function friendlyDetectedLabel(serviceNowName) {
    return String(serviceNowName || '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (ch) => ch.toUpperCase());
  }

  function normalizeAliases(aliases, label) {
    const out = [];
    const seen = new Set();
    for (const alias of [label, ...(aliases || [])]) {
      const normalized = normalizeLabel(alias);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(String(alias).trim());
    }
    return out;
  }

  function detectedKeyFor(serviceNowName) {
    return `detected:${String(serviceNowName || '').trim()}`;
  }

  function normalizeInternalName(value) {
    return String(value || '').trim();
  }

  function internalCompanionBaseName(serviceNowName) {
    const name = normalizeInternalName(serviceNowName);
    if (!name || name === '_input') return '';
    if (name.endsWith('_input') && name.length > '_input'.length) {
      return name.slice(0, -'_input'.length);
    }
    if (name.endsWith('-date') && name.length > '-date'.length) {
      return name.slice(0, -'-date'.length);
    }
    return '';
  }

  function isInternalDiscoveryNoiseName(serviceNowName) {
    const name = normalizeInternalName(serviceNowName);
    if (!name) return false;
    if (name === '_input') return true;
    return Boolean(internalCompanionBaseName(name));
  }

  function isDetectedKey(key) {
    return typeof key === 'string' && key.startsWith('detected:');
  }

  function serviceNowNameFromDetectedKey(key) {
    return isDetectedKey(key) ? key.slice('detected:'.length) : '';
  }

  function createFieldMeta(field, source = 'static') {
    const serviceNowName = String(
      field.serviceNowName ||
      field.hint ||
      (source === 'detected' ? serviceNowNameFromDetectedKey(field.key) : field.key) ||
      ''
    ).trim();
    const label = String(field.label || friendlyDetectedLabel(serviceNowName)).trim();
    const key = String(
      field.key ||
      (source === 'detected' ? detectedKeyFor(serviceNowName) : serviceNowName)
    ).trim();
    return {
      ...field,
      key,
      label,
      aliases: normalizeAliases(field.aliases, label),
      group: field.group || (source === 'detected' ? 'Detected Field Changes' : 'Other'),
      renderAs: field.renderAs || 'text',
      source,
      serviceNowName,
      hint: serviceNowName,
      escapedKey: escapeCssIdentifier(key),
      escapedHint: serviceNowName ? escapeCssIdentifier(serviceNowName) : ''
    };
  }

  const STATIC_FIELDS = Object.freeze(RAW_FIELDS.map((field) => Object.freeze(createFieldMeta(field))));
  const staticByKey = Object.freeze(Object.fromEntries(STATIC_FIELDS.map((field) => [field.key, field])));
  const FIELDS = STATIC_FIELDS.slice();
  const byKey = Object.assign(Object.create(null), staticByKey);
  const allKeys = FIELDS.map((field) => field.key);
  const discoveredByKey = new Map();

  function findMatch(list, labelText) {
    const norm = normalizeLabel(labelText);
    if (!norm) return null;
    for (const field of list) {
      if (normalizeLabel(field.label) === norm) return field;
      if ((field.aliases || []).some((alias) => normalizeLabel(alias) === norm)) return field;
    }
    return null;
  }

  function findByLabel(labelText) {
    return findMatch(FIELDS, labelText);
  }

  function findStaticByLabel(labelText) {
    return findMatch(STATIC_FIELDS, labelText);
  }

  function hasStaticField(serviceNowName) {
    return Boolean(serviceNowName && staticByKey[serviceNowName]);
  }

  function canonicalKey(key) {
    const serviceNowName = serviceNowNameFromDetectedKey(key);
    return serviceNowName && hasStaticField(serviceNowName) ? serviceNowName : key;
  }

  function createDetectedField(field) {
    return createFieldMeta({
      ...field,
      key: field && field.key ? field.key : detectedKeyFor(field && field.serviceNowName)
    }, 'detected');
  }

  /* Known fields reported by discovery carry a live-detected section. Keep the
   * curated label/aliases/renderAs but let the real form section win for the
   * group (curated group stays only when no section was detected). */
  function applyKnownOverride(staticMeta, detected) {
    const merged = { ...staticMeta };
    const liveGroup = String(detected && detected.group || '').replace(/\s+/g, ' ').trim();
    if (liveGroup && liveGroup !== 'Other') merged.group = liveGroup;
    return merged;
  }

  /* Rebuild the active field list from the pristine static catalog plus any
   * persisted discovery metadata.
   *
   * - Entries with `reason: 'known'` map onto a static field (by key, falling
   *   back to serviceNowName) and only ever override its group.
   * - Genuinely new fields (`detected:*` keys) are appended like before.
   * - The static catalog always stays the base so selected keys keep
   *   resolving even before the form has been scanned. */
  function refreshDiscoveredFields(fields) {
    for (const key of discoveredByKey.keys()) delete byKey[key];
    discoveredByKey.clear();

    const nextKnown = STATIC_FIELDS.slice();
    const knownIndexByKey = new Map(nextKnown.map((field, index) => [field.key, index]));
    const knownByServiceNowName = new Map(nextKnown.map((field) => [field.serviceNowName, field]));

    const nextDetected = [];
    for (const field of fields || []) {
      const serviceNowName = normalizeInternalName(field && field.serviceNowName);
      if (!serviceNowName) continue;

      if (field && field.reason === 'known') {
        const staticMeta = staticByKey[field.key] || knownByServiceNowName.get(serviceNowName);
        if (!staticMeta) continue;
        const index = knownIndexByKey.get(staticMeta.key);
        if (index == null) continue;
        nextKnown[index] = applyKnownOverride(staticMeta, field);
        continue;
      }

      const meta = createDetectedField(field);
      if (!meta.serviceNowName) continue;
      if (hasStaticField(meta.serviceNowName)) continue;
      if (staticByKey[meta.key] || discoveredByKey.has(meta.key)) continue;
      discoveredByKey.set(meta.key, meta);
      nextDetected.push(meta);
    }

    nextDetected.sort((a, b) => (
      a.label.localeCompare(b.label) ||
      a.serviceNowName.localeCompare(b.serviceNowName)
    ));

    FIELDS.splice(0, FIELDS.length, ...nextKnown);
    allKeys.splice(0, allKeys.length, ...nextKnown.map((field) => field.key));
    for (const field of nextKnown) byKey[field.key] = field;

    for (const field of nextDetected) {
      FIELDS.push(field);
      allKeys.push(field.key);
      byKey[field.key] = field;
    }
    return FIELDS;
  }

  function getDetectedFields() {
    return Array.from(discoveredByKey.values());
  }

  refreshDiscoveredFields([]);

  NS.fieldRegistry = {
    STATIC_FIELDS,
    FIELDS,
    byKey,
    allKeys,
    staticByKey,
    normalizeLabel,
    friendlyDetectedLabel,
    findByLabel,
    findStaticByLabel,
    refreshDiscoveredFields,
    getDetectedFields,
    detectedKeyFor,
    internalCompanionBaseName,
    isInternalDiscoveryNoiseName,
    isDetectedKey,
    serviceNowNameFromDetectedKey,
    hasStaticField,
    canonicalKey,
    createDetectedField
  };
})(typeof self !== 'undefined' ? self : globalThis);
