
import React, { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { ShadowSimulator } from 'leaflet-shadow-simulator';
import { toast } from 'sonner';

// Fix for default markers in Leaflet
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

interface Restaurant {
  id: string;
  lat: number;
  lng: number;
  name: string;
  terraceCoords?: { lat: number; lng: number };
  shadeStatus?: 'shade' | 'no_shade';
  cloudStatus?: 'cloudy' | 'not_cloudy';
  sunnyStatus?: 'sunny' | 'not_sunny';
}

interface Weather {
  cloudcover: number;
}

const SHADOW_API_KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImJhb2JhYnRlYUBpY2xvdWQuY29tIiwiY3JlYXRlZCI6MTc1MTM3Nzk3NDYwOCwiaWF0IjoxNzUxMzc3OTc0fQ.O0EFcdZDqy3FzCBOVvOvgSgcCVOgHypnS-KyynSZ_VA';

const RestaurantMap = () => {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<L.Map | null>(null);
  const shadowSimulator = useRef<any>(null);
  const [restaurants, setRestaurants] = useState<Restaurant[]>([]);
  const [currentZoom, setCurrentZoom] = useState(10);
  const [isLoading, setIsLoading] = useState(false);
  const restaurantMarkers = useRef<L.CircleMarker[]>([]);
  const terraceMarkers = useRef<L.CircleMarker[]>([]);

  // Calculate bearing between two points
  const calculateBearing = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const lat1Rad = lat1 * Math.PI / 180;
    const lat2Rad = lat2 * Math.PI / 180;
    
    const x = Math.sin(dLng) * Math.cos(lat2Rad);
    const y = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLng);
    
    return Math.atan2(x, y);
  };

  // Calculate new coordinates given a bearing and distance
  const calculateNewCoords = (lat: number, lng: number, bearing: number, distance: number) => {
    const R = 6371000; // Earth's radius in meters
    const d = distance / R;
    const lat1 = lat * Math.PI / 180;
    const lng1 = lng * Math.PI / 180;

    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(bearing));
    const lng2 = lng1 + Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));

    return {
      lat: lat2 * 180 / Math.PI,
      lng: lng2 * 180 / Math.PI
    };
  };

  // Fetch restaurants from Overpass API
  const fetchRestaurants = async (bounds: L.LatLngBounds) => {
    const query = `
      [out:json][timeout:25];
      (
        node["amenity"="restaurant"](${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()});
      );
      out;
    `;

    try {
      const response = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        body: query,
      });

      if (!response.ok) throw new Error('Failed to fetch restaurants');
      
      const data = await response.json();
      
      return data.elements.map((element: any) => ({
        id: element.id.toString(),
        lat: element.lat,
        lng: element.lon,
        name: element.tags?.name || 'Unknown Restaurant'
      }));
    } catch (error) {
      console.error('Error fetching restaurants:', error);
      toast.error('Failed to fetch restaurants');
      return [];
    }
  };

  // Find nearest road for a restaurant
  const findNearestRoad = async (lat: number, lng: number) => {
    const radius = 100; // meters
    const query = `
      [out:json][timeout:25];
      (
        way["highway"](around:${radius},${lat},${lng});
      );
      out geom;
    `;

    try {
      const response = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        body: query,
      });

      if (!response.ok) throw new Error('Failed to fetch roads');
      
      const data = await response.json();
      
      if (data.elements.length === 0) {
        return { lat, lng }; // Return original coordinates if no road found
      }

      // Find the closest point on the nearest road
      let closestPoint = { lat, lng };
      let minDistance = Infinity;

      data.elements.forEach((way: any) => {
        if (way.geometry) {
          way.geometry.forEach((point: any) => {
            const distance = Math.sqrt(
              Math.pow(point.lat - lat, 2) + Math.pow(point.lon - lng, 2)
            );
            if (distance < minDistance) {
              minDistance = distance;
              closestPoint = { lat: point.lat, lng: point.lon };
            }
          });
        }
      });

      return closestPoint;
    } catch (error) {
      console.error('Error finding nearest road:', error);
      return { lat, lng };
    }
  };

  // Get weather data from Open-Meteo
  const getWeatherData = async (lat: number, lng: number): Promise<Weather> => {
    try {
      const response = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=cloudcover&timezone=auto`
      );
      
      if (!response.ok) throw new Error('Failed to fetch weather');
      
      const data = await response.json();
      return {
        cloudcover: data.current?.cloudcover || 0
      };
    } catch (error) {
      console.error('Error fetching weather:', error);
      return { cloudcover: 0 };
    }
  };

  // Check if location is in shadow using shadow simulator
  const checkShadowStatus = async (lat: number, lng: number): Promise<'shade' | 'no_shade'> => {
    try {
      if (!shadowSimulator.current) {
        return 'no_shade';
      }

      const now = new Date();
      const hour = now.getHours();
      
      // Consider nighttime as shade
      if (hour < 6 || hour > 20) {
        return 'shade';
      }

      // Use shadow simulator to check for shadows
      const isInShadow = await shadowSimulator.current.isInShadow(lat, lng, now);
      return isInShadow ? 'shade' : 'no_shade';
    } catch (error) {
      console.error('Error checking shadow status:', error);
      return 'no_shade';
    }
  };

  // Process restaurants with all calculations
  const processRestaurants = async (restaurantData: any[]) => {
    setIsLoading(true);
    const processedRestaurants: Restaurant[] = [];

    for (const restaurant of restaurantData) {
      try {
        // Step 2: Find nearest road and calculate terrace coordinates
        const nearestRoad = await findNearestRoad(restaurant.lat, restaurant.lng);
        const bearing = calculateBearing(restaurant.lat, restaurant.lng, nearestRoad.lat, nearestRoad.lng);
        const terraceCoords = calculateNewCoords(restaurant.lat, restaurant.lng, bearing, 5);

        // Step 3: Check shadow status
        const shadeStatus = await checkShadowStatus(terraceCoords.lat, terraceCoords.lng);

        // Step 4: Get weather data
        const weather = await getWeatherData(restaurant.lat, restaurant.lng);
        const cloudStatus = weather.cloudcover > 20 ? 'cloudy' : 'not_cloudy';

        // Step 5: Calculate sunny status
        const sunnyStatus = shadeStatus === 'no_shade' && cloudStatus === 'not_cloudy' ? 'sunny' : 'not_sunny';

        processedRestaurants.push({
          ...restaurant,
          terraceCoords,
          shadeStatus,
          cloudStatus,
          sunnyStatus
        });

        // Add small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`Error processing restaurant ${restaurant.name}:`, error);
        processedRestaurants.push({
          ...restaurant,
          terraceCoords: { lat: restaurant.lat, lng: restaurant.lng },
          shadeStatus: 'no_shade',
          cloudStatus: 'not_cloudy',
          sunnyStatus: 'not_sunny'
        });
      }
    }

    setRestaurants(processedRestaurants);
    setIsLoading(false);
  };

  // Update markers on the map
  const updateMarkers = useCallback(() => {
    if (!mapInstance.current) return;

    // Clear existing markers
    restaurantMarkers.current.forEach(marker => mapInstance.current?.removeLayer(marker));
    terraceMarkers.current.forEach(marker => mapInstance.current?.removeLayer(marker));
    restaurantMarkers.current = [];
    terraceMarkers.current = [];

    if (currentZoom < 16) return;

    // Add restaurant markers
    restaurants.forEach(restaurant => {
      const color = restaurant.sunnyStatus === 'sunny' ? '#fbbf24' : '#6b7280';
      
      const restaurantMarker = L.circleMarker([restaurant.lat, restaurant.lng], {
        radius: 8,
        fillColor: color,
        color: '#ffffff',
        weight: 2,
        opacity: 1,
        fillOpacity: 0.8
      }).bindPopup(`
        <div class="p-2">
          <h3 class="font-semibold">${restaurant.name}</h3>
          <p class="text-sm">Status: ${restaurant.sunnyStatus}</p>
          <p class="text-sm">Shade: ${restaurant.shadeStatus}</p>
          <p class="text-sm">Clouds: ${restaurant.cloudStatus}</p>
        </div>
      `);

      restaurantMarker.addTo(mapInstance.current!);
      restaurantMarkers.current.push(restaurantMarker);

      // Add terrace marker
      if (restaurant.terraceCoords) {
        const terraceMarker = L.circleMarker([restaurant.terraceCoords.lat, restaurant.terraceCoords.lng], {
          radius: 4,
          fillColor: '#ef4444',
          color: '#ffffff',
          weight: 1,
          opacity: 1,
          fillOpacity: 0.8
        }).bindPopup(`<div class="p-2"><p class="text-sm">Terrace for ${restaurant.name}</p></div>`);

        terraceMarker.addTo(mapInstance.current!);
        terraceMarkers.current.push(terraceMarker);
      }
    });
  }, [restaurants, currentZoom]);

  // Handle map zoom and movement
  const handleMapUpdate = useCallback(async () => {
    if (!mapInstance.current) return;

    const zoom = mapInstance.current.getZoom();
    setCurrentZoom(zoom);

    if (zoom >= 16) {
      const bounds = mapInstance.current.getBounds();
      const restaurantData = await fetchRestaurants(bounds);
      
      if (restaurantData.length > 0) {
        await processRestaurants(restaurantData);
      }
    } else {
      setRestaurants([]);
    }
  }, []);

  // Initialize map
  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;

    const map = L.map(mapRef.current).setView([52.3676, 4.9041], 10); // Amsterdam

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors'
    }).addTo(map);

    // Initialize shadow simulator
    try {
      shadowSimulator.current = new ShadowSimulator(SHADOW_API_KEY);
    } catch (error) {
      console.error('Error initializing shadow simulator:', error);
    }

    map.on('zoomend moveend', handleMapUpdate);

    mapInstance.current = map;

    return () => {
      map.remove();
      mapInstance.current = null;
    };
  }, [handleMapUpdate]);

  // Update markers when restaurants change
  useEffect(() => {
    updateMarkers();
  }, [updateMarkers]);

  return (
    <div className="relative w-full h-screen">
      <div ref={mapRef} className="w-full h-full" />
      
      {/* Zoom message overlay */}
      {currentZoom < 16 && (
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white bg-opacity-90 px-6 py-4 rounded-lg shadow-lg border-2 border-yellow-400">
          <p className="text-center text-gray-800 font-medium">
            Zoom in more to see sunny spots
          </p>
        </div>
      )}

      {/* Loading overlay */}
      {isLoading && (
        <div className="absolute top-4 right-4 bg-white bg-opacity-90 px-4 py-2 rounded-lg shadow-lg">
          <p className="text-sm text-gray-600">Calculating sunny spots...</p>
        </div>
      )}

      {/* Legend */}
      {currentZoom >= 16 && (
        <div className="absolute bottom-4 left-4 bg-white bg-opacity-90 p-4 rounded-lg shadow-lg">
          <h3 className="font-semibold mb-2">Legend</h3>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full bg-yellow-400 border-2 border-white"></div>
              <span className="text-sm">Sunny restaurants</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full bg-gray-500 border-2 border-white"></div>
              <span className="text-sm">Shaded/cloudy restaurants</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-red-500 border border-white"></div>
              <span className="text-sm">Terraces</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default RestaurantMap;
