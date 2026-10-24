# Third-party notices

## Bundled software

### Leaflet 1.9.4 — `assets/script-0.js`

Unmodified `dist/leaflet.js` from the npm package `leaflet@1.9.4` (only line endings differ). Source: https://leafletjs.com · https://github.com/Leaflet/Leaflet

```
BSD 2-Clause License

Copyright (c) 2010-2023, Volodymyr Agafonkin
Copyright (c) 2010-2011, CloudMade
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Data and online services (not bundled; contacted at run time)

| Service | Used for | Terms to follow |
|---|---|---|
| OpenStreetMap data, © OpenStreetMap contributors (ODbL) | Map tiles, place search results, road network for routing | Keep the visible attribution. https://www.openstreetmap.org/copyright |
| OpenStreetMap standard tiles (`tile.openstreetmap.org`) | Default base map | Tile usage policy; no heavy or bulk use. https://operations.osmfoundation.org/policies/tiles/ |
| Photon demo server (`photon.komoot.io`) | Place search | Fair use only; self-host for real traffic. https://github.com/komoot/photon#demo-server |
| Valhalla public server by FOSSGIS (`valhalla1.openstreetmap.de`) | Motorcycle routing | Fair use; identify your deployment with `PLANNER_CLIENT_ID`. https://valhalla.github.io/valhalla/ |
| Google Maps (Street View iframe, `maps/dir` links) | Street-level imagery and navigation hand-off | Google Maps / Google Maps Platform Terms. The Street View iframe uses a legacy consumer embed URL, which is **not** the official Maps Embed API; see README before any public deployment. https://cloud.google.com/maps-platform/terms |
