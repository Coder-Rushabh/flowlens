import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { listPlaces, reportPlace } from "./lib/db";

const Stack = createNativeStackNavigator();

function PlacesScreen() {
  listPlaces("Pune");
  return null;
}

function ReportScreen() {
  reportPlace(1, "closed");
  return null;
}

export default function App() {
  return (
    <Stack.Navigator>
      <Stack.Screen name="Places" component={PlacesScreen} />
      <Stack.Screen name="Report" component={ReportScreen} />
    </Stack.Navigator>
  );
}
