import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import HomeScreen from '../screens/HomeScreen';
import SetupScreen from '../screens/SetupScreen';
import { useSession } from '../lib/SessionContext';
import { colors } from '../theme';

export type RootStackParamList = {
  Setup: undefined;
  Home: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function RootNavigator() {
  const { session, loading } = useSession();

  if (loading) return null;

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerTintColor: colors.text, headerStyle: { backgroundColor: colors.bg } }}>
        {!session ? (
          <Stack.Screen name="Setup" component={SetupScreen} options={{ title: 'Connect' }} />
        ) : (
          <Stack.Screen name="Home" component={HomeScreen} options={{ title: 'BIS API Platform' }} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
