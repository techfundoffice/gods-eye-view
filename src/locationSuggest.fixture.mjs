/**
 * Synthetic multi-park payload for "Disneyland". Constructed name + address +
 * coordinate fields (same style as locations.test.mjs), not a captured Google
 * Places response — Google Maps content may not be stored.
 */
export const DISNEYLAND_SUGGEST_FIXTURE = {
  places: [
    {
      displayName: { text: 'Disneyland Park' },
      formattedAddress: '1313 Disneyland Dr, Anaheim, CA 92802, USA',
      location: { latitude: 33.8121, longitude: -117.919 },
      types: ['amusement_park'],
    },
    {
      displayName: { text: 'Magic Kingdom Park' },
      formattedAddress: 'Walt Disney World Resort, Orlando, FL 32830, USA',
      location: { latitude: 28.4177, longitude: -81.5812 },
      types: ['amusement_park'],
    },
    {
      displayName: { text: 'Disneyland Park' },
      formattedAddress: 'Boulevard de Parc, 77700 Chessy, France',
      location: { latitude: 48.8674, longitude: 2.7836 },
      types: ['amusement_park'],
    },
    {
      displayName: { text: 'Tokyo Disneyland' },
      formattedAddress: '1-1 Maihama, Urayasu, Chiba 279-0031, Japan',
      location: { latitude: 35.6329, longitude: 139.8804 },
      types: ['amusement_park'],
    },
  ],
};
