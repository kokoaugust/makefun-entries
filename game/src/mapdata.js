// Emberline Depot as pure data: every solid in the yard is an axis-aligned box (or one cylinder,
// the silo), so the renderer, the collision solver, the bullet solver and the bots all read the
// same list and can never disagree about where a wall is. Coordinates are metres: x east, z south,
// the yard floor is 64 by 44, centred on the origin.
//
// A box is [centreX, centreZ, sizeX, sizeZ, height, material]. Materials are keys into the
// palette/texture table in world.js: concrete, concreteDark, crate, containerA/B/C, metal, roof.

export const YARD = { halfX: 32, halfZ: 22, wallHeight: 5 };

export const BOXES = [
  // Perimeter walls (thickness 1, just outside the play area).
  [0, -22.5, 66, 1, 5, 'concreteDark'],
  [0, 22.5, 66, 1, 5, 'concreteDark'],
  [-32.5, 0, 1, 46, 5, 'concreteDark'],
  [32.5, 0, 1, 46, 5, 'concreteDark'],

  // Site A, the North Silo (north-west). The silo itself is the cylinder below; these are its
  // crate stacks and the low wall that breaks the long sightline into the site.
  [-14, -16, 2.2, 2.2, 2.1, 'crate'],
  [-14, -13.2, 2.2, 2.2, 1.15, 'crate'],
  [-17.5, -8.5, 3.2, 1.6, 1.15, 'crate'],
  [-11, -19, 9, 1, 3.4, 'concrete'],
  [-26, -9, 1, 7, 3.4, 'concrete'],

  // The A-long corridor along the north edge: container cover halfway down.
  [-2, -19.5, 6, 2.4, 2.6, 'containerB'],
  [8, -17, 2.2, 2.2, 2.1, 'crate'],

  // The warehouse in the middle: four walls with a doorway in each, crates inside. It is the
  // hinge of the map; both side lanes bend around it.
  [-4.5, -5, 8, 1, 4.2, 'concrete'],      // north wall, two pieces with a doorway between
  [4.75, -5, 6.5, 1, 4.2, 'concrete'],
  [-4.75, 5, 6.5, 1, 4.2, 'concrete'],    // south wall, two pieces with a doorway between
  [4.5, 5, 8, 1, 4.2, 'concrete'],
  [-8.5, -3.25, 1, 4.5, 4.2, 'concrete'], // west wall, two pieces with a doorway between
  [-8.5, 3.25, 1, 4.5, 4.2, 'concrete'],
  [8.5, -3.25, 1, 4.5, 4.2, 'concrete'],  // east wall, two pieces with a doorway between
  [8.5, 3.25, 1, 4.5, 4.2, 'concrete'],
  [-3, 0.5, 2.2, 2.2, 2.1, 'crate'],      // inside cover
  [3.5, -1, 2.2, 2.2, 1.15, 'crate'],
  [0, 2.8, 3.2, 1.4, 1.15, 'crate'],

  // Mid-south apron between the warehouse and the B approach.
  [-4, 12, 2.2, 2.2, 2.1, 'crate'],
  [5, 15, 6, 2.4, 2.6, 'containerC'],

  // Site B, the South Dock (south-east): two containers make the plant pocket, a wall behind
  // them breaks the defender's view from spawn.
  [16, 9.5, 6, 2.4, 2.6, 'containerA'],
  [23, 16, 2.4, 6, 2.6, 'containerB'],
  [13.5, 17.5, 4, 2, 1.3, 'crate'],
  [10, 19, 9, 1, 3.4, 'concrete'],
  [27, 8, 1, 7, 3.4, 'concrete'],

  // B-long corridor along the south edge.
  [2, 19.5, 6, 2.4, 2.6, 'containerA'],
  [-9, 17, 2.2, 2.2, 1.15, 'crate'],

  // Loose cover on the two spawn aprons.
  [-24, 8, 2.2, 2.2, 1.15, 'crate'],
  [24, -8, 2.2, 2.2, 2.1, 'crate'],
  [18, -14, 3.2, 1.6, 1.15, 'crate'],
  [-20, 2, 2.2, 2.2, 2.1, 'crate'],
];

// The silo: a cylinder for the eye, an enclosing box for collision and bullets.
export const SILO = { x: -23, z: -16, radius: 3.1, height: 9.5 };
export const SILO_BOX = [-23, -16, 6.2, 6.2, 9.5, 'metal'];
export const SOLIDS = BOXES.concat([SILO_BOX]);

// The two plant sites: a charge planted inside the radius counts.
export const SITES = [
  { id: 'A', name: 'North Silo', x: -19, z: -13, radius: 4.6 },
  { id: 'B', name: 'South Dock', x: 19, z: 13.5, radius: 4.6 },
];

// Spawn points, five a side, spread so a team never stacks on one spot.
export const SPAWNS = {
  attack: [
    [-27, 17], [-24.5, 19], [-22, 16.5], [-27, 13.5], [-23, 12.5],
  ],
  defend: [
    [27, -17], [24.5, -19], [22, -16.5], [27, -13.5], [23, -12.5],
  ],
};

// The waypoint graph the bots walk. Nodes are [x, z]; edges are index pairs. Every lane of the
// map is on the graph, and every site, spawn and cover point is within a step of some node.
export const NODES = [
  [-26, 15],   // 0  attacker spawn
  [-19, 9],    // 1  south-west apron
  [-12, 5],    // 2  warehouse south-west corner
  [-17, -2],   // 3  west lane
  [-15, -10],  // 4  A approach
  [-19, -13],  // 5  site A
  [-7, -14],   // 6  A-long west
  [3, -15],    // 7  A-long east
  [-24, -6],   // 8  A back lane
  [0, 15],     // 9  south apron
  [-1, 8],     // 10 warehouse south door
  [0, 0],      // 11 warehouse middle
  [1, -8],     // 12 warehouse north door
  [12, 5],     // 13 east lane south
  [16, -3],    // 14 east lane north
  [19, 13.5],  // 15 site B
  [11, 16],    // 16 B approach
  [26, -15],   // 17 defender spawn
  [19, -11.5], // 18 north-east apron
  [10, -14.5], // 19 defender A-long post
  [-4, 18],    // 20 south lane west
  [24, 5],     // 21 defender B lane
  [20, 20],    // 22 B back lane
  [5, 9],      // 23 warehouse south-east
  [-18.5, -18],// 24 silo shoulder (beside site A)
  [25.5, 20],  // 25 dock shoulder (beside site B)
];

export const EDGES = [
  [0, 1], [1, 2], [1, 3], [2, 10], [2, 20], [3, 4], [3, 8], [4, 5], [4, 6], [5, 24], [5, 8],
  [6, 7], [6, 12], [7, 19], [8, 24], [9, 10], [9, 20], [9, 23], [10, 11], [11, 12],
  [12, 7], [13, 14], [13, 16], [13, 23], [14, 18], [14, 21], [15, 16], [16, 22],
  [17, 18], [17, 21], [18, 19], [20, 16], [21, 25], [22, 25],
];

// Where a bot stops to hold an angle, per site and for mid. Chosen beside cover in SOLIDS.
export const COVER = {
  A: [[-15.5, -11], [-21, -9.5], [-12.5, -15], [-24.5, -11]],
  B: [[15, 11], [21.5, 10.5], [12.5, 15.5], [24.5, 17]],
  mid: [[-6, 3], [6, -3], [-10, -2], [10, 2]],
};
