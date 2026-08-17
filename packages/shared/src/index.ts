export interface ClientApp {
  id: string;
  name: string;
  category: string;
}

export const CLIENT_APPS: ClientApp[] = [
  { id: 'reachchurch', name: 'ReachChurch', category: 'Religious' },
  { id: 'afribook', name: 'Afribook', category: 'Social/Education' },
  { id: 'haulpro', name: 'HaulPro', category: 'Logistics' },
  { id: 'stayscape', name: 'STAYSCAPE', category: 'Travel/Hospitality' },
  { id: 'eventhub', name: 'EventHub', category: 'Entertainment' },
  { id: 'ridely', name: 'Ride-ly', category: 'Transport/Ride-hailing' },
  { id: 'food', name: 'Food', category: 'Food Delivery' },
  { id: 'futureapps', name: 'Future Apps', category: 'Incubation' }
];

export const DEFAULT_PORT = 3001;
export const DEFAULT_VITE_PORT = 5173;
