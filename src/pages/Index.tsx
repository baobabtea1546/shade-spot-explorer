
import RestaurantMap from '@/components/RestaurantMap';

const Index = () => {
  return (
    <div className="min-h-screen bg-background">
      <div className="absolute top-4 left-4 z-[1000] bg-white bg-opacity-90 px-4 py-2 rounded-lg shadow-lg">
        <h1 className="text-xl font-bold text-gray-800">Sunny Spots Finder</h1>
        <p className="text-sm text-gray-600">Find restaurants with sunny terraces</p>
      </div>
      <RestaurantMap />
    </div>
  );
};

export default Index;
