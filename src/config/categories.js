const CATEGORIES = [
  { name: 'General Service', basePrice: 1499, icon: 'construct', requiredEquipment: [] },
  { name: 'Oil Change', basePrice: 999, icon: 'water', requiredEquipment: [] },
  { name: 'Brake Service', basePrice: 899, icon: 'disc', requiredEquipment: [] },
  { name: 'AC Service', basePrice: 1999, icon: 'snow', requiredEquipment: ['AC gas kit'] },
  { name: 'Engine Repair', basePrice: 3500, icon: 'cog', instantBook: false, requiredEquipment: ['Diagnostic scanner'] },
  { name: 'Battery Replacement', basePrice: 2500, icon: 'battery-charging', requiredEquipment: [] },
  { name: 'Tyres & Wheels', basePrice: 1200, icon: 'ellipse', requiredEquipment: ['Wheel balancer'] },
];
const slug = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

module.exports = { CATEGORIES, slug };