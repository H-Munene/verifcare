// The county -> constituency -> ward cascade for dependant registration (HEZ-86 revision) -
// three LocationCombobox dropdowns plus the OpenStreetMap/Leaflet visualization
// (LocationSelectorMap), matching the inspiration screenshots in temp_images/ exactly: hovering an
// option previews its boundary on the map; selecting one zooms in and narrows the next dropdown's
// options to its children; the deepest selection replaces, rather than layers under, the previous
// level's display (see LocationSelectorMap.tsx's own header comment).
//
// Reports the final ward selection up via onWardResolved, including the ward's own geometry - the
// next step (ExactLocationMap.tsx) needs that polygon both to bound the Google Maps view and to
// validate the dropped pin actually falls inside it, not just its bounding box.

import { useEffect, useState } from 'react';
import {
  getConstituencyFeature,
  getCountyFeature,
  getWardFeature,
  getWardFeaturesInConstituency,
  loadConstituencies,
  loadCounties,
  loadWards,
  type ConstituencyFeature,
  type ConstituencyOption,
  type CountyFeature,
  type CountyOption,
  type WardFeature,
  type WardOption,
} from '../geo/adminBoundaries';
import { Card } from '../design-system/Card';
import { LocationCombobox } from './LocationCombobox';
import { LocationSelectorMap } from './LocationSelectorMap';
import './LocationSelector.css';

export interface ResolvedWard {
  countyName: string;
  constituencyName: string;
  wardName: string;
  wardFeature: WardFeature;
}

export interface LocationSelectorProps {
  // Pre-fills the cascade when editing a dependant that already has these set - looked up by name
  // against the loaded lists (the API only stores plain names, not codes), rather than requiring
  // the backend to also start storing codes just for this.
  initialCountyName?: string | null;
  initialConstituencyName?: string | null;
  initialWardName?: string | null;
  onWardResolved: (resolved: ResolvedWard | null) => void;
}

export function LocationSelector({
  initialCountyName,
  initialConstituencyName,
  initialWardName,
  onWardResolved,
}: LocationSelectorProps) {
  const [countyOptions, setCountyOptions] = useState<CountyOption[]>([]);
  const [constituencyOptions, setConstituencyOptions] = useState<ConstituencyOption[]>([]);
  const [wardOptions, setWardOptions] = useState<WardOption[]>([]);

  const [selectedCounty, setSelectedCounty] = useState<CountyOption | null>(null);
  const [selectedConstituency, setSelectedConstituency] = useState<ConstituencyOption | null>(null);
  const [selectedWard, setSelectedWard] = useState<WardOption | null>(null);

  const [selectedCountyFeature, setSelectedCountyFeature] = useState<CountyFeature | null>(null);
  const [hoveredCountyFeature, setHoveredCountyFeature] = useState<CountyFeature | null>(null);
  const [selectedConstituencyFeature, setSelectedConstituencyFeature] =
    useState<ConstituencyFeature | null>(null);
  const [hoveredConstituencyFeature, setHoveredConstituencyFeature] =
    useState<ConstituencyFeature | null>(null);
  const [wardFeaturesInConstituency, setWardFeaturesInConstituency] = useState<WardFeature[]>([]);
  const [selectedWardFeature, setSelectedWardFeature] = useState<WardFeature | null>(null);
  const [hoveredWardFeature, setHoveredWardFeature] = useState<WardFeature | null>(null);

  // Load counties once, then hydrate from initial* names if editing an existing dependant.
  useEffect(() => {
    void loadCounties().then((options) => {
      setCountyOptions(options);
      if (initialCountyName) {
        const match = options.find((o) => o.name.toLowerCase() === initialCountyName.toLowerCase());
        if (match) {
          setSelectedCounty(match);
        }
      }
    });
    // Only ever runs once, at mount - the initial* props are a one-time hydration seed, not meant
    // to re-trigger this on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Each effect below only ever fetches for a truthy selection - clearing derived state when a
  // selection is cleared happens synchronously in the handlers just below instead (an ordinary
  // event handler, not an effect body, per this project's own react-hooks/set-state-in-effect
  // convention), so there is nothing left for the early-return branch to do.
  useEffect(() => {
    if (!selectedCounty) {
      return;
    }
    void getCountyFeature(selectedCounty.code).then(setSelectedCountyFeature);
    void loadConstituencies(selectedCounty.code).then((options) => {
      setConstituencyOptions(options);
      if (initialConstituencyName && !selectedConstituency) {
        const match = options.find(
          (o) => o.name.toLowerCase() === initialConstituencyName.toLowerCase(),
        );
        if (match) {
          setSelectedConstituency(match);
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCounty]);

  useEffect(() => {
    if (!selectedConstituency) {
      return;
    }
    void getConstituencyFeature(selectedConstituency.code).then(setSelectedConstituencyFeature);
    void getWardFeaturesInConstituency(selectedConstituency.code).then(
      setWardFeaturesInConstituency,
    );
    void loadWards(selectedConstituency.code).then((options) => {
      setWardOptions(options);
      if (initialWardName && !selectedWard) {
        const match = options.find((o) => o.name.toLowerCase() === initialWardName.toLowerCase());
        if (match) {
          setSelectedWard(match);
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedConstituency]);

  useEffect(() => {
    if (!selectedWard) {
      return;
    }
    void getWardFeature(selectedWard.code).then((feature) => {
      setSelectedWardFeature(feature);
      if (feature && selectedCounty && selectedConstituency) {
        onWardResolved({
          countyName: selectedCounty.name,
          constituencyName: selectedConstituency.name,
          wardName: selectedWard.name,
          wardFeature: feature,
        });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWard]);

  function handleSelectCounty(option: CountyOption | null) {
    setSelectedCounty(option);
    setSelectedConstituency(null);
    setSelectedWard(null);
    setConstituencyOptions([]);
    setWardOptions([]);
    // Clearing the county's own feature too (not just its descendants') - without this, clearing
    // the county selection left the map still showing the just-cleared county's boundary, since
    // LocationSelectorMap renders off this feature state, not the plain option state.
    setSelectedCountyFeature(null);
    setHoveredCountyFeature(null);
    setSelectedConstituencyFeature(null);
    setWardFeaturesInConstituency([]);
    setSelectedWardFeature(null);
    onWardResolved(null);
  }

  function handleSelectConstituency(option: ConstituencyOption | null) {
    setSelectedConstituency(option);
    setSelectedWard(null);
    setWardOptions([]);
    setSelectedConstituencyFeature(null);
    setWardFeaturesInConstituency([]);
    setSelectedWardFeature(null);
    onWardResolved(null);
  }

  function handleSelectWard(option: WardOption | null) {
    setSelectedWard(option);
    if (!option) {
      setSelectedWardFeature(null);
      onWardResolved(null);
    }
  }

  function handleHoverCounty(option: CountyOption | null) {
    if (!option) {
      setHoveredCountyFeature(null);
      return;
    }
    void getCountyFeature(option.code).then(setHoveredCountyFeature);
  }

  function handleHoverConstituency(option: ConstituencyOption | null) {
    if (!option) {
      setHoveredConstituencyFeature(null);
      return;
    }
    void getConstituencyFeature(option.code).then(setHoveredConstituencyFeature);
  }

  function handleHoverWard(option: WardOption | null) {
    if (!option) {
      setHoveredWardFeature(null);
      return;
    }
    const feature = wardFeaturesInConstituency.find((f) => f.properties.ward_code === option.code);
    setHoveredWardFeature(feature ?? null);
  }

  return (
    <div className="location-selector">
      <Card className="location-selector__panel">
        <div className="location-selector__panel-header">
          <span className="location-selector__title">Location Selector</span>
          {selectedCounty ? (
            <button
              type="button"
              className="location-selector__reset"
              onClick={() => handleSelectCounty(null)}
            >
              Reset All
            </button>
          ) : null}
        </div>

        <LocationCombobox
          label="1. County"
          countHint={`${countyOptions.length} available`}
          options={countyOptions}
          getCode={(o) => o.code}
          getName={(o) => o.name}
          value={selectedCounty}
          onSelect={handleSelectCounty}
          onHoverOption={handleHoverCounty}
          placeholder="Search or select county..."
        />
        <LocationCombobox
          label="2. Constituency"
          countHint={selectedCounty ? `${constituencyOptions.length} available` : undefined}
          options={constituencyOptions}
          getCode={(o) => o.code}
          getName={(o) => o.name}
          value={selectedConstituency}
          onSelect={handleSelectConstituency}
          onHoverOption={handleHoverConstituency}
          disabled={!selectedCounty}
          placeholder="Search constituency..."
        />
        <LocationCombobox
          label="3. Ward"
          countHint={selectedConstituency ? `${wardOptions.length} available` : undefined}
          options={wardOptions}
          getCode={(o) => o.code}
          getName={(o) => o.name}
          value={selectedWard}
          onSelect={handleSelectWard}
          onHoverOption={handleHoverWard}
          disabled={!selectedConstituency}
          placeholder="Search ward..."
        />

        <div className="location-selector__summary">
          <div className="location-selector__summary-title">Selection summary</div>
          {!selectedCounty ? (
            <p className="location-selector__summary-text">
              No location selected. The map displays the full national extent of Kenya.
            </p>
          ) : (
            <>
              <div className="location-selector__chips">
                <span className="location-selector__chip location-selector__chip--county">
                  County: {selectedCounty.name}
                </span>
                {selectedConstituency ? (
                  <span className="location-selector__chip location-selector__chip--constituency">
                    Constituency: {selectedConstituency.name}
                  </span>
                ) : null}
                {selectedWard ? (
                  <span className="location-selector__chip location-selector__chip--ward">
                    Ward: {selectedWard.name}
                  </span>
                ) : null}
              </div>
              <p className="location-selector__summary-text">
                {selectedWard
                  ? `Selected ward ${selectedWard.name} in ${selectedConstituency?.name} constituency, ${selectedCounty.name} county.`
                  : selectedConstituency
                    ? `Selected constituency ${selectedConstituency.name}. Select a ward to continue.`
                    : `Selected county ${selectedCounty.name}. Select a constituency to zoom in further.`}
              </p>
            </>
          )}
        </div>
      </Card>

      <LocationSelectorMap
        selectedCounty={selectedCountyFeature}
        hoveredCounty={hoveredCountyFeature}
        selectedConstituency={selectedConstituencyFeature}
        hoveredConstituency={hoveredConstituencyFeature}
        wardsInConstituency={wardFeaturesInConstituency}
        selectedWard={selectedWardFeature}
        hoveredWard={hoveredWardFeature}
      />
    </div>
  );
}
