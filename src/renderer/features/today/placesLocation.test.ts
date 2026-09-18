import { describe, expect, it } from 'vitest';
import { findPlacesSource, parsePlacesLocation } from './placesLocation';

const listing = (formattedAddress?: string) => JSON.stringify({ id: 'place-1', displayName: 'Fictional PM', formattedAddress, nationalPhoneNumber: '(401) 555-0100', websiteUri: 'https://example.invalid/' });

describe('parsePlacesLocation', () => {
  it('reads city and state from the saved Places excerpt and nothing else', () => {
    expect(parsePlacesLocation(listing('12 Main St, Providence, RI 02903, USA'))).toEqual({ city: 'Providence', state: 'RI', formattedAddress: '12 Main St, Providence, RI 02903, USA' });
    expect(parsePlacesLocation(listing('Suite 4, 900 Congress Ave, Austin, TX 78701, United States'))).toMatchObject({ city: 'Austin', state: 'TX' });
    expect(parsePlacesLocation(listing('Boston, MA'))).toMatchObject({ city: 'Boston', state: 'MA' });
    expect(parsePlacesLocation(listing('Boston, MA 02108-1234'))).toMatchObject({ city: 'Boston', state: 'MA' });
  });
  it('answers null for anything that is not a Places listing with an address, and keeps unknown parts unknown', () => {
    expect(parsePlacesLocation('We manage residential homes across Rhode Island.')).toBeNull();
    expect(parsePlacesLocation(listing())).toBeNull();
    expect(parsePlacesLocation(listing('   '))).toBeNull();
    expect(parsePlacesLocation('{"formattedAddress": 12}')).toBeNull();
    expect(parsePlacesLocation('null')).toBeNull();
    // A street alone is not a city; a state alone is still a state.
    expect(parsePlacesLocation(listing('12 Main St'))).toEqual({ city: null, state: null, formattedAddress: '12 Main St' });
    expect(parsePlacesLocation(listing('RI 02903'))).toEqual({ city: null, state: 'RI', formattedAddress: 'RI 02903' });
  });
  it('finds the one listing among saved sources', () => {
    const sources = [{ id: 'site', excerpt: 'Plain fetched page text' }, { id: 'places', excerpt: listing('1 Elm St, Warwick, RI 02886, USA') }];
    expect(findPlacesSource(sources)).toMatchObject({ id: 'places', location: { city: 'Warwick', state: 'RI' } });
    expect(findPlacesSource([sources[0]!])).toBeNull();
  });
});
