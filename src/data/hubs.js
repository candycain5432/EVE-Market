// The five NPC trade hubs, plus their regions. Station/system/region IDs are
// static in EVE, so they are safe to hard-code; everything else comes from ESI.

export const HUBS = [
  {
    id: 60003760,
    key: 'jita',
    name: 'Jita IV-4',
    station: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant',
    system: 'Jita',
    systemId: 30000142,
    regionId: 10000002,
    region: 'The Forge',
    security: 0.9,
  },
  {
    id: 60008494,
    key: 'amarr',
    name: 'Amarr VIII',
    station: 'Amarr VIII (Oris) - Emperor Family Academy',
    system: 'Amarr',
    systemId: 30002187,
    regionId: 10000043,
    region: 'Domain',
    security: 1.0,
  },
  {
    id: 60011866,
    key: 'dodixie',
    name: 'Dodixie IX-20',
    station: 'Dodixie IX - Moon 20 - Federation Navy Assembly Plant',
    system: 'Dodixie',
    systemId: 30002659,
    regionId: 10000032,
    region: 'Sinq Laison',
    security: 0.9,
  },
  {
    id: 60004588,
    key: 'rens',
    name: 'Rens VI-8',
    station: 'Rens VI - Moon 8 - Brutor Tribe Treasury',
    system: 'Rens',
    systemId: 30002510,
    regionId: 10000030,
    region: 'Heimatar',
    security: 0.9,
  },
  {
    id: 60005686,
    key: 'hek',
    name: 'Hek VIII-12',
    station: 'Hek VIII - Moon 12 - Boundless Creation Factory',
    system: 'Hek',
    systemId: 30002053,
    regionId: 10000042,
    region: 'Metropolis',
    security: 0.5,
  },
];

export const HUB_BY_ID = new Map(HUBS.map((hub) => [hub.id, hub]));

export function hub(id) {
  return HUB_BY_ID.get(Number(id)) || HUBS[0];
}

/** Regions the hubs live in, for region-wide (non station-filtered) scans. */
export const REGIONS = HUBS.map((hubDef) => ({
  id: hubDef.regionId,
  name: hubDef.region,
  hubId: hubDef.id,
}));

export function regionName(regionId) {
  const found = REGIONS.find((r) => r.id === Number(regionId));
  return found ? found.name : `Region ${regionId}`;
}
